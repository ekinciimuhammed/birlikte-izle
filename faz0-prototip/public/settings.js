// Ayarlar elle çizilmez: bu şemadan üretilir. Yeni bir ayar = şemaya bir satır.
// (Faz 1'deki defineSetting() altyapısının küçük bir provası.)

export const SCHEMA = [
  {
    group: 'Yayın',
    footer: 'Film görüntüsünün karşı tarafa nasıl gideceği. Codec ikinizde de aynı olur.',
    items: [
      {
        key: 'bitrate',
        label: 'En yüksek bit hızı',
        type: 'select',
        options: [[2, '2 Mbps'], [4, '4 Mbps'], [6, '6 Mbps'], [8, '8 Mbps'], [12, '12 Mbps']],
        default: 6,
      },
      {
        key: 'priority',
        label: 'Öncelik',
        type: 'segmented',
        options: [['motion', 'Akıcılık'], ['detail', 'Netlik']],
        default: 'motion',
      },
      {
        key: 'codec',
        label: 'Codec',
        type: 'select',
        options: [['auto', 'Otomatik'], ['vp9', 'VP9'], ['h264', 'H.264'], ['av1', 'AV1']],
        default: 'auto',
      },
    ],
  },
  {
    group: 'Film sesi',
    footer: 'Film sesi işlenmeden, stereo gönderilir. Mikrofonun yankı engelleme açık kalır.',
    items: [
      {
        key: 'audioBitrate',
        label: 'Ses kalitesi',
        type: 'select',
        options: [[96, 'Standart'], [192, 'Yüksek'], [256, 'En yüksek']],
        default: 192,
      },
    ],
  },
  {
    group: 'Kamera',
    items: [
      {
        key: 'camRes',
        label: 'Çözünürlük',
        type: 'select',
        options: [[360, '360p'], [540, '540p'], [720, '720p']],
        default: 540,
      },
      { key: 'mirror', label: 'Kendimi ayna gibi göster', type: 'toggle', default: true },
    ],
  },
  {
    group: 'Kontrol',
    items: [
      {
        key: 'skip',
        label: 'İleri / geri atlama',
        type: 'select',
        options: [[5, '5 sn'], [10, '10 sn'], [30, '30 sn']],
        default: 10,
      },
    ],
  },
];

const STORAGE_KEY = 'birlikte-izle:ayarlar';

export const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Gizli pencere vb.: ayarlar bu oturumla sınırlı kalır.
    }
  },
};

export function loadSettings() {
  const defaults = Object.fromEntries(SCHEMA.flatMap((g) => g.items.map((i) => [i.key, i.default])));
  return { ...defaults, ...store.get(STORAGE_KEY, {}) };
}

export function saveSettings(values) {
  store.set(STORAGE_KEY, values);
}

export function renderSettings(container, values, onChange) {
  container.replaceChildren(
    ...SCHEMA.map((group) => {
      const section = document.createElement('section');
      section.innerHTML = `<h3 class="group-title">${group.group}</h3>`;
      const inset = document.createElement('div');
      inset.className = 'inset';
      for (const item of group.items) inset.append(renderRow(item, values[item.key], (v) => onChange(item.key, v)));
      section.append(inset);
      if (group.footer) {
        const footer = document.createElement('p');
        footer.className = 'group-footer';
        footer.textContent = group.footer;
        section.append(footer);
      }
      return section;
    }),
  );
}

function renderRow(item, value, set) {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('span');
  label.textContent = item.label;
  row.append(label);

  if (item.type === 'select') {
    const select = document.createElement('select');
    for (const [v, text] of item.options) select.add(new Option(text, v, false, v === value));
    select.addEventListener('change', () => {
      const raw = select.value;
      set(typeof item.default === 'number' ? Number(raw) : raw);
    });
    row.append(select);
  } else if (item.type === 'segmented') {
    const seg = document.createElement('div');
    seg.className = 'segmented';
    for (const [v, text] of item.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.setAttribute('aria-pressed', String(v === value));
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        set(v);
      });
      seg.append(b);
    }
    row.append(seg);
  } else if (item.type === 'toggle') {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!value));
    sw.setAttribute('aria-label', item.label);
    sw.addEventListener('click', () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(next));
      set(next);
    });
    row.append(sw);
  }
  return row;
}
