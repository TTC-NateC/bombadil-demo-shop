/**
 * Full-bleed TTC teal section.
 *
 * ttcglobal.com sets whole page sections on --teal / --dark-blue rather than
 * tinting individual cards, so the catalog, PDP, and cart all sit on one band
 * instead of each re-deriving the same breakout classes.
 *
 * The breakout cancels <main>'s px-6/py-8 and spans the viewport; the min-height
 * subtracts the header so a short page still fills the screen (--header-h lives
 * in globals.css next to the palette).
 */
export function PageBand({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="relative left-1/2 -my-8 min-h-[calc(100vh-var(--header-h))] w-screen -translate-x-1/2 bg-ttc-teal py-10">
      <div className={`mx-auto max-w-6xl px-6 ${className}`}>{children}</div>
    </div>
  );
}
