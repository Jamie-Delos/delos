// Inline SVG icons lifted to match the designer's stroke style (1.7–1.9, round caps).
const S = (p: { d: string; extra?: React.ReactNode; sw?: number; size?: number }) => (
  <svg width={p.size ?? 19} height={p.size ?? 19} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={p.sw ?? 1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d={p.d} />{p.extra}
  </svg>
);

export const IcHome = () => <S d="M3 11l9-8 9 8M5 10v10h14V10" sw={1.9} />;
export const IcToken = () => <S d="M12 7.4v9.2M14.3 9.2c-.5-.8-1.4-1.3-2.4-1.3-1.5 0-2.6 1-2.6 2.2 0 2.6 5.2 1.4 5.2 4 0 1.2-1.1 2.2-2.6 2.2-1 0-1.9-.5-2.4-1.3" sw={1.7} extra={<circle cx="12" cy="12" r="9" />} />;
export const IcAdvanced = () => <S d="M2 8h3M9.4 8H22M2 16h11.6M18.4 16H22" sw={1.7} extra={<><circle cx="7" cy="8" r="2.4" /><circle cx="16" cy="16" r="2.4" /></>} />;
export const IcProfile = () => <S d="M6 19a6 6 0 0112 0" sw={1.7} extra={<><circle cx="12" cy="12" r="9.2" /><circle cx="12" cy="9.5" r="3" /></>} />;
export const IcMore = () => <S d="" sw={1.9} extra={<><circle cx="12" cy="5" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="12" cy="19" r="1.3" /></>} />;
export const IcSearch = () => <S d="M21 21l-4.3-4.3" sw={1.9} extra={<circle cx="11" cy="11" r="7" />} />;
export const IcPlus = () => <S d="M12 5v14M5 12h14" sw={2} />;
export const IcBack = () => <S d="M15 6l-6 6 6 6" sw={2} size={16} />;
export const IcCopy = () => <S d="M9 9h10v10H9zM5 15H4V4h11v1" sw={1.7} size={15} />;
export const IcTg = () => <S d="M21 4L3 11l5 2 2 6 3-4 5 4 3-15z" sw={1.6} size={17} />;
