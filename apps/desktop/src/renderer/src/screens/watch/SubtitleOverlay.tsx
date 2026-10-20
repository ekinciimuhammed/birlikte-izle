// Altyazı katmanı: ekrandaki karenin zamanına göre (izleyen tarafta yayın gecikmesi düşülmüş)
// her karede doğru satırı gösterir. Görünüm kişiye özel; kontroller açıkken yukarı kayar.

import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useSetting } from '../../settings/store';
import type { Cue } from '../../subtitles/parse';
import { cx } from '../../ui/controls';
import { watch } from '../../watch/controller';

export function SubtitleOverlay({ raised }: { raised: boolean }) {
  const [cues, setCues] = useState<Cue[]>([]);
  const size = useSetting('subtitles.size');
  const color = useSetting('subtitles.color');
  const style = useSetting('subtitles.style');

  useEffect(() => {
    let frame = 0;
    let last = '';
    const loop = () => {
      const now = watch.cuesNow();
      const key = now.map((c) => `${c.start}|${c.text}`).join('\n');
      if (key !== last) {
        last = key;
        setCues(now);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  if (!cues.length) return null;
  return (
    <div className={cx('subtitles', `size-${size}`, `color-${color}`, `style-${style}`, raised && 'raised')} aria-live="polite">
      {cues.map((c, i) => (
        <div key={`${c.start}-${i}`} className="subtitle-cue">
          {c.text.split('\n').map((line, j) => (
            <span key={j} className="subtitle-line">
              {renderInline(line)}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** <i>, <b>, <u> → React; başka hiçbir şey HTML olarak yorumlanmaz. */
function renderInline(line: string): ReactNode {
  const out: ReactNode[] = [];
  const re = /<(\/?)([ibu])>/g;
  let pos = 0;
  const open = { i: false, b: false, u: false };
  let m: RegExpExecArray | null;
  const push = (text: string) => {
    if (!text) return;
    let node: ReactNode = text;
    if (open.u) node = <u>{node}</u>;
    if (open.b) node = <b>{node}</b>;
    if (open.i) node = <i>{node}</i>;
    out.push(<Fragment key={out.length}>{node}</Fragment>);
  };
  while ((m = re.exec(line))) {
    push(line.slice(pos, m.index));
    open[m[2] as 'i' | 'b' | 'u'] = m[1] !== '/';
    pos = re.lastIndex;
  }
  push(line.slice(pos));
  return out;
}
