// Small UI helpers shared by both pages: profile photos and avatars.
const escAttr = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A photo that fails to load falls back to the initials underneath (no inline handlers, so the security policy can block them).
if (typeof document !== 'undefined') document.addEventListener('error', e => { const t = e.target; if (t && t.tagName === 'IMG' && t.parentElement && t.parentElement.classList.contains('av')) t.remove(); }, true);

// Only these photo sources are ever shown (the database rules allow the same).
export const safePhoto = src => typeof src === 'string' && (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src) || /^https:\/\/t\.me\/i\/userpic\/[^"'<>\s]+$/.test(src)) ? src : '';

export function initials(name) {
  let n = String(name || '').trim();
  if (n.includes(',')) n = n.split(',').reverse().join(' ');
  const parts = n.split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hue(key) { let h = 0; for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

// A round photo, or coloured initials when there isn't one.
export function avatar(name, src, size = 32, key = name) {
  const s = safePhoto(src);
  const style = `--s:${size}px;--h:${hue(key)}`;
  return s
    ? `<span class="av" style="${style}"><img src="${escAttr(s)}" alt="" loading="lazy" referrerpolicy="no-referrer"><i>${escAttr(initials(name))}</i></span>`
    : `<span class="av" style="${style}"><i>${escAttr(initials(name))}</i></span>`;
}

// Shrinks a picked image to a small square JPEG (about 3–6 KB) so it fits in the database and loads fast.
// The biggest avatar on screen is 64px, so 128px stays sharp on high-resolution phones.
export function shrinkPhoto(file, size = 128) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error('not_image'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      let out = c.toDataURL('image/jpeg', 0.8);
      if (out.length > 38000) out = c.toDataURL('image/jpeg', 0.6);
      out.length > 38000 ? reject(new Error('too_big')) : resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not_image')); };
    img.src = url;
  });
}
