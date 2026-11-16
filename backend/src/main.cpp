#include <drogon/drogon.h>
#include <drogon/orm/DbClient.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iterator>
#include <memory>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>

namespace
{
using Callback = std::function<void(const drogon::HttpResponsePtr &)>;
using SharedCallback = std::shared_ptr<Callback>;

std::string envOr(const char *name, const std::string &fallback)
{
    const auto *value = std::getenv(name);
    return value != nullptr && *value != '\0' ? value : fallback;
}

int envInt(const char *name, int fallback, int minimum, int maximum)
{
    try
    {
        return std::clamp(std::stoi(envOr(name, std::to_string(fallback))), minimum, maximum);
    }
    catch (...)
    {
        return fallback;
    }
}

std::string readFile(const std::filesystem::path &path)
{
    std::ifstream input(path);
    if (!input)
    {
        throw std::runtime_error("SQL-Datei kann nicht gelesen werden: " + path.string());
    }
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

std::string isoNow()
{
    const auto now = std::chrono::system_clock::now();
    const auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  now.time_since_epoch()) %
                              1000;
    const auto time = std::chrono::system_clock::to_time_t(now);
    std::tm utc{};
    gmtime_r(&time, &utc);
    std::ostringstream output;
    output << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.'
           << std::setw(3) << std::setfill('0') << milliseconds.count() << 'Z';
    return output.str();
}

std::int64_t nowMilliseconds()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

bool validMeterId(const std::string &value)
{
    static const std::regex pattern(R"(^[A-Za-z0-9_.:-]{1,64}$)");
    return std::regex_match(value, pattern);
}

int boundedParameter(const drogon::HttpRequestPtr &request,
                     const std::string &name,
                     int fallback,
                     int minimum,
                     int maximum)
{
    const auto value = request->getParameter(name);
    if (value.empty())
    {
        return fallback;
    }
    try
    {
        return std::clamp(std::stoi(value), minimum, maximum);
    }
    catch (...)
    {
        return fallback;
    }
}

std::array<std::int64_t, 5> parseCursor(const std::string &cursor)
{
    std::array<std::int64_t, 5> values{};
    std::stringstream input(cursor);
    std::string part;
    std::size_t index = 0;
    while (std::getline(input, part, '.'))
    {
        if (index >= values.size() || part.empty())
        {
            throw std::invalid_argument("Cursorformat ist ungültig");
        }
        std::size_t consumed = 0;
        const auto value = std::stoll(part, &consumed);
        if (consumed != part.size() || value < 0)
        {
            throw std::invalid_argument("Cursorformat ist ungültig");
        }
        values[index++] = value;
    }
    if (index != values.size())
    {
        throw std::invalid_argument("Cursorformat ist ungültig");
    }
    return values;
}

class LiveApi final
{
  public:
    LiveApi(drogon::orm::DbClientPtr database,
            std::string snapshotSql,
            std::string updatesSql,
            std::string corsOrigin)
        : database_(std::move(database)),
          snapshotSql_(std::move(snapshotSql)),
          updatesSql_(std::move(updatesSql)),
          corsOrigin_(std::move(corsOrigin))
    {
    }

    void snapshot(const drogon::HttpRequestPtr &request, Callback &&callback) const
    {
        if (preflight(request, callback))
        {
            return;
        }

        const auto meterId = request->getParameter("meter_id");
        if (!validMeterId(meterId))
        {
            respondError(std::move(callback), drogon::k400BadRequest,
                         "meter_id fehlt oder ist ungültig");
            return;
        }

        const auto windowMinutes = boundedParameter(request, "window_minutes", 15, 1, 1440);
        const auto limit = boundedParameter(request, "limit", 2000, 100, 20000);
        const auto bucketSeconds = boundedParameter(request, "bucket_seconds", 5, 1, 3600);
        const auto fromMilliseconds = nowMilliseconds() -
                                      static_cast<std::int64_t>(windowMinutes) * 60 * 1000;
        const auto done = std::make_shared<Callback>(std::move(callback));

        (*database_) << snapshotSql_ << meterId << fromMilliseconds << limit << bucketSeconds >>
            [this, done](const drogon::orm::Result &result) {
                respondEnvelope(result, done);
            } >>
            [this, done](const drogon::orm::DrogonDbException &error) {
                respondDatabaseError(error, done);
            };
    }

    void updates(const drogon::HttpRequestPtr &request, Callback &&callback) const
    {
        if (preflight(request, callback))
        {
            return;
        }

        const auto meterId = request->getParameter("meter_id");
        if (!validMeterId(meterId))
        {
            respondError(std::move(callback), drogon::k400BadRequest,
                         "meter_id fehlt oder ist ungültig");
            return;
        }

        std::array<std::int64_t, 5> cursor{};
        try
        {
            cursor = parseCursor(request->getParameter("after_cursor"));
        }
        catch (const std::exception &error)
        {
            respondError(std::move(callback), drogon::k400BadRequest, error.what());
            return;
        }

        const auto limit = boundedParameter(request, "limit", 2000, 100, 20000);
        const auto done = std::make_shared<Callback>(std::move(callback));
        (*database_) << updatesSql_ << meterId << cursor[0] << cursor[1] << cursor[2]
                     << cursor[3] << cursor[4] << limit >>
            [this, done](const drogon::orm::Result &result) {
                respondEnvelope(result, done);
            } >>
            [this, done](const drogon::orm::DrogonDbException &error) {
                respondDatabaseError(error, done);
            };
    }

    void lastSeen(const drogon::HttpRequestPtr &request, Callback &&callback) const
    {
        if (preflight(request, callback))
        {
            return;
        }
        const auto meterId = request->getParameter("meter_id");
        if (!validMeterId(meterId))
        {
            respondError(std::move(callback), drogon::k400BadRequest,
                         "meter_id fehlt oder ist ungültig");
            return;
        }

        static const std::string sql = R"SQL(
            SELECT max(b.timestamp) AS last_seen
              FROM public.basic_measurement_values AS b
              JOIN public.input_channels AS c USING (channel_id)
             WHERE c.meter_id = $1
        )SQL";
        const auto done = std::make_shared<Callback>(std::move(callback));
        (*database_) << sql << meterId >>
            [this, done](const drogon::orm::Result &result) {
                Json::Value body;
                body["serverTime"] = isoNow();
                if (!result.empty() && !result[0]["last_seen"].isNull())
                {
                    body["lastSeen"] = result[0]["last_seen"].as<std::string>();
                }
                else
                {
                    body["lastSeen"] = Json::nullValue;
                }
                auto response = drogon::HttpResponse::newHttpJsonResponse(body);
                addCors(response);
                (*done)(response);
            } >>
            [this, done](const drogon::orm::DrogonDbException &error) {
                respondDatabaseError(error, done);
            };
    }

    void health(const drogon::HttpRequestPtr &request, Callback &&callback) const
    {
        if (preflight(request, callback))
        {
            return;
        }
        const auto done = std::make_shared<Callback>(std::move(callback));
        (*database_) << "SELECT 1 AS ok" >>
            [this, done](const drogon::orm::Result &) {
                Json::Value body;
                body["status"] = "ok";
                body["database"] = "reachable";
                body["serverTime"] = isoNow();
                auto response = drogon::HttpResponse::newHttpJsonResponse(body);
                addCors(response);
                (*done)(response);
            } >>
            [this, done](const drogon::orm::DrogonDbException &error) {
                Json::Value body;
                body["status"] = "error";
                body["database"] = "unreachable";
                body["message"] = error.base().what();
                auto response = drogon::HttpResponse::newHttpJsonResponse(body);
                response->setStatusCode(drogon::k503ServiceUnavailable);
                addCors(response);
                (*done)(response);
            };
    }

  private:
    bool preflight(const drogon::HttpRequestPtr &request, Callback &callback) const
    {
        if (request->method() != drogon::Options)
        {
            return false;
        }
        auto response = drogon::HttpResponse::newHttpResponse();
        response->setStatusCode(drogon::k204NoContent);
        addCors(response);
        callback(response);
        return true;
    }

    void addCors(const drogon::HttpResponsePtr &response) const
    {
        response->addHeader("Access-Control-Allow-Origin", corsOrigin_);
        response->addHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        response->addHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        response->addHeader("Access-Control-Max-Age", "600");
        response->addHeader("Vary", "Origin");
        response->addHeader("Cache-Control", "no-store");
    }

    void respondEnvelope(const drogon::orm::Result &result,
                         const SharedCallback &done) const
    {
        if (result.empty() || result[0]["payload"].isNull())
        {
            respondError(done, drogon::k404NotFound,
                         "Keine Live-Daten für das Messgerät gefunden");
            return;
        }

        Json::Value body;
        Json::CharReaderBuilder builder;
        std::string errors;
        const auto payload = result[0]["payload"].as<std::string>();
        std::istringstream input(payload);
        if (!Json::parseFromStream(builder, input, &body, &errors))
        {
            LOG_ERROR << "Ungültige JSON-Antwort aus PostgreSQL: " << errors;
            respondError(done, drogon::k500InternalServerError,
                         "Datenbankantwort konnte nicht serialisiert werden");
            return;
        }

        body["serverTime"] = isoNow();
        const auto thresholdConfig = body["thresholdConfig"];
        const auto nominal = thresholdConfig.get("nominalVoltage", 230.0).asDouble();
        body["thresholds"]["nominalVoltage"] = nominal;
        body["thresholds"]["dipVoltage"] =
            nominal * thresholdConfig.get("dipFactor", 0.90).asDouble();
        body["thresholds"]["swellVoltage"] =
            nominal * thresholdConfig.get("swellFactor", 1.10).asDouble();
        body.removeMember("thresholdConfig");

        for (auto &event : body["events"])
        {
            if (event["durationMs"].isNull() && event["durationUs"].isNumeric())
            {
                event["durationMs"] = event["durationUs"].asDouble() / 1000.0;
            }
            event.removeMember("durationUs");
            event.removeMember("dipResidualVoltage");
        }

        auto response = drogon::HttpResponse::newHttpJsonResponse(body);
        addCors(response);
        (*done)(response);
    }

    void respondDatabaseError(const drogon::orm::DrogonDbException &error,
                              const SharedCallback &done) const
    {
        LOG_ERROR << "PostgreSQL-Abfrage fehlgeschlagen: " << error.base().what();
        respondError(done, drogon::k503ServiceUnavailable,
                     "PostgreSQL ist nicht erreichbar oder die Abfrage ist fehlgeschlagen");
    }

    void respondError(Callback &&callback,
                      drogon::HttpStatusCode status,
                      const std::string &message) const
    {
        auto done = std::make_shared<Callback>(std::move(callback));
        respondError(done, status, message);
    }

    void respondError(const SharedCallback &done,
                      drogon::HttpStatusCode status,
                      const std::string &message) const
    {
        Json::Value body;
        body["error"] = message;
        body["serverTime"] = isoNow();
        auto response = drogon::HttpResponse::newHttpJsonResponse(body);
        response->setStatusCode(status);
        addCors(response);
        (*done)(response);
    }

    drogon::orm::DbClientPtr database_;
    std::string snapshotSql_;
    std::string updatesSql_;
    std::string corsOrigin_;
};
} // namespace

int main()
{
    try
    {
        const auto databaseHost = envOr("DB_HOST", "127.0.0.1");
        const auto databasePort = envInt("DB_PORT", 5432, 1, 65535);
        const auto databaseName = envOr("POSTGRES_DB", "powerquality");
        const auto databaseUser = envOr("POSTGRES_USER", "pq_admin");
        const auto databasePassword = envOr("POSTGRES_PASSWORD", "");
        const auto databaseConnections = envInt("DB_CONNECTIONS", 4, 1, 32);
        const auto bindAddress = envOr("API_BIND_ADDRESS", "0.0.0.0");
        const auto apiPort = envInt("API_PORT", 8080, 1, 65535);
        const auto apiThreads = envInt("API_THREADS", 2, 1, 32);
        const auto corsOrigin = envOr("API_CORS_ORIGIN", "http://localhost:4200");
        const auto sqlDirectory = std::filesystem::path(envOr("PQM_SQL_DIR", "./sql"));

        std::ostringstream connection;
        connection << "host=" << databaseHost << " port=" << databasePort
                   << " dbname=" << databaseName << " user=" << databaseUser
                   << " password=" << databasePassword
                   << " connect_timeout=5 application_name=pqm_drogon_api";

        auto database = drogon::orm::DbClient::newPgClient(
            connection.str(), static_cast<std::size_t>(databaseConnections));
        auto api = std::make_shared<LiveApi>(
            std::move(database),
            readFile(sqlDirectory / "snapshot.sql"),
            readFile(sqlDirectory / "updates.sql"),
            corsOrigin);

        drogon::app().registerHandler(
            "/api/v1/live/snapshot",
            [api](const drogon::HttpRequestPtr &request, Callback &&callback) {
                api->snapshot(request, std::move(callback));
            },
            {drogon::Get, drogon::Options});
        drogon::app().registerHandler(
            "/api/v1/live/updates",
            [api](const drogon::HttpRequestPtr &request, Callback &&callback) {
                api->updates(request, std::move(callback));
            },
            {drogon::Get, drogon::Options});
        drogon::app().registerHandler(
            "/api/v1/live/last-seen",
            [api](const drogon::HttpRequestPtr &request, Callback &&callback) {
                api->lastSeen(request, std::move(callback));
            },
            {drogon::Get, drogon::Options});
        drogon::app().registerHandler(
            "/healthz",
            [api](const drogon::HttpRequestPtr &request, Callback &&callback) {
                api->health(request, std::move(callback));
            },
            {drogon::Get, drogon::Options});

        LOG_INFO << "PQM Drogon API startet auf " << bindAddress << ':' << apiPort;
        drogon::app()
            .addListener(bindAddress, static_cast<std::uint16_t>(apiPort))
            .setThreadNum(static_cast<std::size_t>(apiThreads))
            .setClientMaxBodySize(1024 * 1024)
            .run();
    }
    catch (const std::exception &error)
    {
        LOG_FATAL << "PQM Drogon API konnte nicht gestartet werden: " << error.what();
        return 1;
    }
    return 0;
}
