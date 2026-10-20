// İleri/geri atlama simgesi: ok + saniye. (Diğer simgeler lucide-react'tan.)

export function SkipIcon({ direction, seconds }: { direction: 'back' | 'forward'; seconds: number }) {
  const back = direction === 'back';
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {back ? (
        <>
          <path d="M3 12a9 9 0 1 0 2.64-6.36L3 8.3" />
          <path d="M3 3.5v4.8h4.8" />
        </>
      ) : (
        <>
          <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8.3" />
          <path d="M21 3.5v4.8h-4.8" />
        </>
      )}
      <text
        x="12"
        y="15.4"
        textAnchor="middle"
        fontSize="7.2"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
        fontFamily="system-ui, sans-serif"
      >
        {seconds}
      </text>
    </svg>
  );
}

export function HeartFilled({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"
      />
    </svg>
  );
}
