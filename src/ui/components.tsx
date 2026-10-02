/** Small UI-kit components over the RMCProfile class names in ui.css. */
import { useEffect, useId, useState, type ReactNode } from "react";

export function cx(...names: (string | false | undefined | null)[]): string {
  return names.filter(Boolean).join(" ");
}

export function InfoBadge({ children, label = "More information" }: { children: ReactNode; label?: string }) {
  const id = useId();
  return (
    <span className="ui-info">
      <button type="button" className="ui-info__trigger" aria-label={label} aria-describedby={id}>
        ?
      </button>
      <span role="tooltip" id={id} className="ui-info__popover">
        {children}
      </span>
    </span>
  );
}

export function Card({ title, meta, actions, info, children, flush, className }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; info?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={cx("ui-card", className)}>
      <h2 className="ui-card__header">
        <span className="ui-card__title">
          {title}
          {info && <InfoBadge>{info}</InfoBadge>}
          {meta && <span className="ui-card__meta">{meta}</span>}
        </span>
        {actions && <span className="ui-card__actions">{actions}</span>}
      </h2>
      <div className={cx("ui-card__body", flush && "ui-card__body--flush")}>{children}</div>
    </section>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: ReactNode; disabled?: boolean }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ui-seg ui-seg--frame" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={cx(o.value === value && "is-active")} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Number field with the unit inside the border. Commits on Enter or blur and
 * keeps invalid text visible (flagged) instead of silently reverting it.
 */
export function UnitField({ value, unit, onCommit, min, max, label, width }: { value: number; unit: string; onCommit: (v: number) => void; min?: number; max?: number; label: string; width?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const parsed = Number(text);
  const valid = text.trim() !== "" && Number.isFinite(parsed) && (min === undefined || parsed >= min) && (max === undefined || parsed <= max);
  const commit = () => {
    if (valid && parsed !== value) onCommit(parsed);
  };
  return (
    <span className={cx("ui-unit-field", !valid && "is-invalid")} title={valid ? undefined : `Enter a number${min !== undefined ? ` ≥ ${min}` : ""}${max !== undefined ? ` ≤ ${max}` : ""}`}>
      <input
        className="ui-unit-field__input"
        aria-label={label}
        inputMode="decimal"
        value={text}
        style={width ? { width } : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <span className="ui-unit-field__unit">{unit}</span>
    </span>
  );
}

export function Chip({ tone, children, title }: { tone?: "success" | "warn" | "danger" | "accent" | undefined; children: ReactNode; title?: string }) {
  return (
    <span className={cx("ui-chip", tone && `ui-chip--${tone}`)} title={title}>
      {children}
    </span>
  );
}

export function TierChip({ tier }: { tier: string }) {
  const tone = tier === "certified" ? "success" : tier === "crosschecked" ? "accent" : tier === "discrepant" ? "warn" : "danger";
  const label = tier === "crosschecked" ? "crosschecked · not certified" : tier;
  return <Chip tone={tone}>{label}</Chip>;
}
