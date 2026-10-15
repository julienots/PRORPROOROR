/** Mini-bibliothèque DOM pour l'interface (sans framework). */
type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: HTMLElement): HTMLElement {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  log?: boolean;
  unit?: string;
  format?: (v: number) => string;
  onInput?: (v: number) => void;
  onChange?: (v: number) => void;
  hint?: string;
  testid?: string;
}

/** Curseur avec affichage de la valeur et saisie numérique directe. */
export function slider(o: SliderOpts): HTMLElement & { setValue(v: number): void } {
  const toPos = (v: number) => (o.log ? (Math.log10(Math.max(v, o.min)) - Math.log10(o.min)) / (Math.log10(o.max) - Math.log10(o.min)) * 1000 : v);
  const fromPos = (p: number) => (o.log ? Math.pow(10, Math.log10(o.min) + (p / 1000) * (Math.log10(o.max) - Math.log10(o.min))) : p);
  const fmt = o.format ?? ((v: number) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(2) : Number(v.toPrecision(4)).toString()));
  const input = h('input', {
    type: 'range',
    min: o.log ? 0 : o.min,
    max: o.log ? 1000 : o.max,
    step: o.log ? 1 : o.step ?? (o.max - o.min) / 200,
    value: toPos(o.value),
    'data-testid': o.testid,
  }) as HTMLInputElement;
  const num = h('input', { type: 'text', class: 'num', value: fmt(o.value) }) as HTMLInputElement;
  const wrap = h('div', { class: 'field slider' },
    h('label', null, o.label, o.hint ? h('span', { class: 'hint', title: o.hint }, ' ⓘ') : null),
    h('div', { class: 'row' }, input, num, o.unit ? h('span', { class: 'unit' }, o.unit) : null),
  ) as unknown as HTMLElement & { setValue(v: number): void };
  input.addEventListener('input', () => {
    const v = fromPos(Number(input.value));
    num.value = fmt(v);
    o.onInput?.(v);
  });
  input.addEventListener('change', () => o.onChange?.(fromPos(Number(input.value))));
  num.addEventListener('change', () => {
    const v = parseFloat(num.value.replace(',', '.').replace('×10', 'e'));
    if (!Number.isFinite(v)) { num.value = fmt(fromPos(Number(input.value))); num.classList.add('bad'); setTimeout(() => num.classList.remove('bad'), 800); return; }
    const c = Math.min(o.max, Math.max(o.min, v));
    input.value = String(toPos(c));
    num.value = fmt(c);
    o.onInput?.(c);
    o.onChange?.(c);
  });
  wrap.setValue = (v: number) => { input.value = String(toPos(v)); num.value = fmt(v); };
  return wrap;
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void, testid?: string): HTMLElement {
  const cb = h('input', { type: 'checkbox', checked: value, 'data-testid': testid }) as HTMLInputElement;
  cb.addEventListener('change', () => onChange(cb.checked));
  return h('label', { class: 'field toggle' }, cb, h('span', null, label));
}

export function select<T extends string>(label: string, options: [T, string][], value: T, onChange: (v: T) => void, testid?: string): HTMLElement {
  const s = h('select', { 'data-testid': testid }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l))) as HTMLSelectElement;
  s.addEventListener('change', () => onChange(s.value as T));
  return h('div', { class: 'field' }, h('label', null, label), s);
}

export function button(label: string, onClick: () => void, cls = '', title?: string, testid?: string): HTMLButtonElement {
  return h('button', { class: `btn ${cls}`, onclick: onClick, title, 'data-testid': testid }, label) as HTMLButtonElement;
}

/** Badge de statut scientifique. */
export function badge(kind: 'etabli' | 'approx' | 'divin' | 'hypothese'): HTMLElement {
  const map = { etabli: ['Science établie', 'b-sci'], approx: ['Approximation', 'b-approx'], divin: ['Pouvoir divin', 'b-div'], hypothese: ['Hypothèse', 'b-hyp'] };
  return h('span', { class: `badge ${map[kind][1]}` }, map[kind][0]);
}

export function readout(label: string, get: () => string, live: (() => void)[]): HTMLElement {
  const v = h('span', { class: 'val' }, get());
  live.push(() => { const t = get(); if (v.textContent !== t) v.textContent = t; });
  return h('div', { class: 'readout' }, h('span', { class: 'lbl' }, label), v);
}

/** Petit graphique ligne(s) sur canvas. */
export function lineChart(canvas: HTMLCanvasElement, series: { data: [number, number][]; color: string; label: string; dash?: boolean }[], opts: { xLabel?: string; yLabel?: string; logY?: boolean; logX?: boolean; marker?: number } = {}): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 44, r: 8, t: 10, b: 26 };
  const tx = (v: number) => (opts.logX ? Math.log10(Math.max(v, 1e-300)) : v);
  const ty = (v: number) => (opts.logY ? Math.log10(Math.max(v, 1e-300)) : v);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of series) for (const [x, y] of s.data) {
    if (!Number.isFinite(tx(x)) || !Number.isFinite(ty(y))) continue;
    x0 = Math.min(x0, tx(x)); x1 = Math.max(x1, tx(x)); y0 = Math.min(y0, ty(y)); y1 = Math.max(y1, ty(y));
  }
  if (!Number.isFinite(x0)) return;
  if (y1 === y0) { y1 += 1; y0 -= 1; }
  if (!opts.logY && y0 > 0) y0 = 0;
  const X = (v: number) => pad.l + ((tx(v) - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const Y = (v: number) => H - pad.b - ((ty(v) - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  ctx.strokeStyle = 'rgba(140,190,255,0.18)';
  ctx.fillStyle = 'rgba(190,215,255,0.7)';
  ctx.font = '10px system-ui';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const yv = y0 + ((y1 - y0) * i) / 4;
    const yy = H - pad.b - ((yv - y0) / (y1 - y0)) * (H - pad.t - pad.b);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    const lab = opts.logY ? `1e${yv.toFixed(1)}` : Math.abs(yv) >= 1000 || (Math.abs(yv) < 0.01 && yv !== 0) ? yv.toExponential(1) : yv.toPrecision(3);
    ctx.fillText(lab, 2, yy + 3);
  }
  const xl = opts.logX ? `1e${x0.toFixed(1)} … 1e${x1.toFixed(1)}` : `${Number(x0.toPrecision(3))} … ${Number(x1.toPrecision(3))}`;
  ctx.fillText(`${opts.xLabel ?? ''} (${xl})`, pad.l, H - 6);
  if (opts.yLabel) { ctx.save(); ctx.translate(10, pad.t + 40); ctx.restore(); }
  series.forEach((s, k) => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.8;
    ctx.setLineDash(s.dash ? [5, 4] : []);
    ctx.beginPath();
    let first = true;
    for (const [x, y] of s.data) {
      if (!Number.isFinite(tx(x)) || !Number.isFinite(ty(y))) continue;
      if (first) { ctx.moveTo(X(x), Y(y)); first = false; } else ctx.lineTo(X(x), Y(y));
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = s.color;
    ctx.fillText(s.label, W - pad.r - 150, pad.t + 12 + k * 13);
  });
  if (opts.marker !== undefined && Number.isFinite(tx(opts.marker))) {
    ctx.strokeStyle = '#ffd060';
    ctx.beginPath(); ctx.moveTo(X(opts.marker), pad.t); ctx.lineTo(X(opts.marker), H - pad.b); ctx.stroke();
  }
}

export function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
