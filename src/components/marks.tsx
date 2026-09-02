'use client'

/** Drawn rather than a glyph, so the two status marks share one stroke weight
 *  and optical size instead of inheriting whatever the font supplies. */
export function WarningMark() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.4 14.4 13.6H1.6L8 2.4Z" />
      <path d="M8 6.6v3" />
      <path d="M8 11.6h.01" />
    </svg>
  )
}

export function UnavailableMark() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.2" />
      <path d="M5.2 8h5.6" />
    </svg>
  )
}


export function PinMark({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5.6 1.9h4.8l-.7 3.5 2.1 2.4H4.2l2.1-2.4-.7-3.5Z" />
      <path d="M8 8.2v5.9" fill="none" />
    </svg>
  )
}

export function RefreshMark() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8" />
      <path d="M13.6 2.2v3.1h-3.1" />
    </svg>
  )
}

export function RemoveMark() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8" />
      <path d="M12 4l-8 8" />
    </svg>
  )
}
