import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { UnbalancePoint } from '../core/live.models';

@Component({
  selector: 'pqm-phasor',
  standalone: true,
  template: `
    <svg viewBox="0 0 320 300" role="img" aria-label="Zeigerdiagramm der drei Phasenspannungen">
      <defs>
        <marker id="arrow-l1" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#38bdf8"/></marker>
        <marker id="arrow-l2" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#a78bfa"/></marker>
        <marker id="arrow-l3" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#2dd4bf"/></marker>
      </defs>
      @for (radius of [35, 70, 105]; track radius) {
        <circle cx="150" cy="145" [attr.r]="radius" class="grid-circle" />
      }
      @for (angle of [0, 30, 60, 90, 120, 150]; track angle) {
        <line x1="30" y1="145" x2="270" y2="145" class="grid-line" [attr.transform]="'rotate(' + angle + ' 150 145)'" />
      }
      <circle cx="150" cy="145" r="4" class="origin" />
      @for (phasor of point?.phasors ?? []; track phasor.phase; let index = $index) {
        <line x1="150" y1="145" [attr.x2]="endX(phasor.magnitude, phasor.angleDeg)" [attr.y2]="endY(phasor.magnitude, phasor.angleDeg)"
          [attr.class]="'vector v-' + phasor.phase.toLowerCase()" [attr.marker-end]="'url(#arrow-' + phasor.phase.toLowerCase() + ')'" />
        <text [attr.x]="labelX(phasor.magnitude, phasor.angleDeg)" [attr.y]="labelY(phasor.magnitude, phasor.angleDeg)" [attr.class]="'label t-' + phasor.phase.toLowerCase()">{{ phasor.phase }}</text>
      }
      <text x="150" y="282" text-anchor="middle" class="caption">Phasenlage und Spannungsbetrag</text>
    </svg>
  `,
  styles: [`
    :host{display:block;min-height:260px} svg{width:100%;height:100%;max-height:300px}.grid-circle,.grid-line{fill:none;stroke:#26364b;stroke-width:1}.grid-line{stroke-dasharray:3 5}.origin{fill:#94a3b8}.vector{stroke-width:3.2}.v-l1{stroke:#38bdf8}.v-l2{stroke:#a78bfa}.v-l3{stroke:#2dd4bf}.label{font:700 13px system-ui}.t-l1{fill:#38bdf8}.t-l2{fill:#a78bfa}.t-l3{fill:#2dd4bf}.caption{fill:#7f91aa;font:12px system-ui}
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhasorComponent {
  @Input() point: UnbalancePoint | null = null;
  private readonly scale = 0.46;
  endX(magnitude: number, angle: number): number { return 150 + Math.cos(angle * Math.PI / 180) * magnitude * this.scale; }
  endY(magnitude: number, angle: number): number { return 145 - Math.sin(angle * Math.PI / 180) * magnitude * this.scale; }
  labelX(magnitude: number, angle: number): number { return 150 + Math.cos(angle * Math.PI / 180) * (magnitude * this.scale + 18); }
  labelY(magnitude: number, angle: number): number { return 149 - Math.sin(angle * Math.PI / 180) * (magnitude * this.scale + 18); }
}
