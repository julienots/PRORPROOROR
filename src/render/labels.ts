/** Couche d'étiquettes HTML positionnées sur les objets 3D (pool réutilisé à chaque image). */
export class LabelLayer {
  readonly root: HTMLDivElement;
  private pool: HTMLDivElement[] = [];
  private used = 0;
  onClick: ((id: string) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'label-layer';
    parent.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
      if (el && this.onClick) {
        e.stopPropagation();
        this.onClick(el.dataset.id!);
      }
    });
  }

  begin(): void {
    this.used = 0;
  }

  add(id: string, text: string, x: number, y: number, cls = '', marker = false): void {
    let el = this.pool[this.used];
    if (!el) {
      el = document.createElement('div');
      el.className = 'label';
      this.root.appendChild(el);
      this.pool.push(el);
    }
    this.used++;
    if (el.dataset.id !== id) el.dataset.id = id;
    const html = (marker ? '<i class="marker"></i>' : '') + `<span>${text}</span>`;
    if (el.dataset.html !== html) {
      el.innerHTML = html;
      el.dataset.html = html;
    }
    const c = `label ${cls}`;
    if (el.className !== c) el.className = c;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    el.style.display = '';
  }

  end(): void {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }

  clear(): void {
    this.begin();
    this.end();
  }
}
