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

