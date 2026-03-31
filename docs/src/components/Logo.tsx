import clsx from 'clsx';

export function Logomark({
  className,
  ...props
}: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 36 36"
      className={clsx('inline-block', className)}
      {...props}
    >
      <rect width="36" height="36" rx="8" fill="#1A1A1E" stroke="#2C2C32" strokeWidth="1" />
      <text
        x="5"
        y="25"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontWeight="700"
        fontSize="18"
      >
        <tspan fill="#F050A0">F</tspan>
        <tspan fill="#A8E848">c</tspan>
      </text>
    </svg>
  );
}

export function Logo({
  className,
  ...props
}: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 180 36"
      className={clsx('inline-block', className)}
      {...props}
    >
      <rect width="36" height="36" rx="8" fill="#1A1A1E" stroke="#2C2C32" strokeWidth="1" />
      <text
        x="5"
        y="25"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontWeight="700"
        fontSize="18"
      >
        <tspan fill="#F050A0">F</tspan>
        <tspan fill="#A8E848">c</tspan>
      </text>
      <text
        x="46"
        y="25"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontWeight="500"
        fontSize="18"
        fill="currentColor"
      >
        Fetchium
      </text>
    </svg>
  );
}
