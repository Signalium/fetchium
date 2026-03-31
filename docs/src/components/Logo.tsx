import clsx from 'clsx';

export function FcTile({ className, size = 'sm' }: { className?: string; size?: 'sm' | 'md' }) {
  const ismd = size === 'md';

  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center rounded-md border border-primary-800 bg-primary-900',
        ismd ? 'h-11 w-11' : 'h-9 w-9',
        className,
      )}
    >
      <span className={clsx('font-mono font-bold leading-none text-tertiary-300', ismd ? 'text-lg' : 'text-base')}>
        Fc
      </span>
      <span className={clsx('font-display text-secondary-300/70', ismd ? 'text-[6px]' : 'text-[5px]')}>
        200
      </span>
    </div>
  );
}

export function Logomark({
  className,
  ...props
}: React.ComponentPropsWithoutRef<'div'>) {
  return <FcTile className={className} size="sm" {...props} />;
}

export function Logo({
  className,
  ...props
}: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div className={clsx('flex items-center gap-2.5', className)} {...props}>
      <FcTile size="sm" />
      <span className="font-display text-[16px] font-medium text-white">
        fetchium
      </span>
    </div>
  );
}
