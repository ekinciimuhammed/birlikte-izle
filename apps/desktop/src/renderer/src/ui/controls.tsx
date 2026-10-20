import { motion } from 'motion/react';
import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'plain' | 'destructive';
  size?: 'small' | 'regular' | 'large';
};

export function Button({ variant = 'primary', size = 'regular', className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={cx('btn', `btn-${variant}`, size !== 'regular' && `btn-${size}`, className)}
      {...rest}
    />
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Erişilebilirlik ve ipucu metni */
  label: string;
  large?: boolean;
  off?: boolean;
};

export function IconButton({ label, large, off, className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('icon-btn', large && 'large', off && 'off', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      onClick={() => onChange(!checked)}
    />
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.value === value && (
            <motion.span
              layoutId={`seg-${id}`}
              className="thumb"
              transition={{ type: 'spring', stiffness: 500, damping: 38 }}
            />
          )}
          <span className="segmented-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <select
      className="select"
      aria-label={label}
      value={String(value)}
      onChange={(e) => {
        const picked = options.find((o) => String(o.value) === e.target.value);
        if (picked) onChange(picked.value);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Spinner() {
  return <span className="spinner" role="progressbar" aria-label="Bekleniyor" />;
}

export function Avatar({ name, size = 40, muted }: { name: string; size?: number; muted?: boolean }) {
  const initial = (name || '?').trim().charAt(0).toLocaleUpperCase('tr-TR');
  return (
    <div className={cx('avatar', muted && 'muted')} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {initial}
    </div>
  );
}

export function Keycaps({ keys }: { keys: string[] }) {
  return (
    <span>
      {keys.map((k) => (
        <kbd key={k} className="keycap">
          {k}
        </kbd>
      ))}
    </span>
  );
}

export function ListSection({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="list-section">
      {title && <h3 className="list-title">{title}</h3>}
      <div className="list">{children}</div>
      {footer && <p className="list-footer">{footer}</p>}
    </section>
  );
}

export function ListRow({ label, children, onClick }: { label: ReactNode; children?: ReactNode; onClick?: () => void }) {
  return (
    <div className={cx('row', onClick && 'clickable')} onClick={onClick}>
      <span className="row-label">{label}</span>
      {children}
    </div>
  );
}

export { cx };
