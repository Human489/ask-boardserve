'use client'

// React explicitly: these marks are rendered server-side by the test suite,
// which compiles JSX with the classic runtime. Next's automatic runtime
// hides the need until a mark is first rendered inside a tested component.
import React from 'react'

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

/**
 * The disclosure affordance on the conversation list.
 *
 * Drawn rather than left to the browser: `<summary>` loses its native marker
 * the moment its `display` is anything but `list-item`, and this one is a flex
 * row. The result was a control that opened a panel with nothing at all to say
 * it could be opened — it read as a label sitting beside a link.
 *
 * Points right when closed and is rotated by CSS when open, so the direction
 * is a single transform rather than two icons that could drift apart.
 */
export function ChevronMark() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
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

/**
 * BoardServe's own mark, taken from the parent product so this reads as part
 * of it rather than as something adjacent wearing similar colours.
 *
 * Inlined rather than served as a file: it is 3KB, it appears on the passcode
 * screen before anything else has loaded, and the app is opened live in
 * meetings where one fewer request is one fewer thing to go wrong.
 *
 * Every path is `currentColor`, so the mark takes whichever accent the active
 * theme supplies — the deep green in light, the lifted green in dark — from
 * one CSS property rather than two hard-coded fills. The source asset ships
 * with a fixed #0F766E, which would have gone muddy on the dark ground.
 *
 * aria-hidden: the wordmark beside it already says "Ask BoardServe", so
 * naming the mark as well would make a screen reader announce the product
 * twice.
 */
export function BoardServeMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 375 472"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14.99 470.366C7.74 468.446 2.83 464.046 0.820004 457.696C0.0900035 455.396 0.0500031 453.046 0.0500031 426.416V397.656H1.67C2.95 397.656 3.8 398.126 6.24 400.046C12.51 405.086 28.77 417.666 49.34 433.376C96.83 469.736 94.36 467.726 94.36 469.566V471.056L55.87 471.016C23.61 471.016 16.95 470.886 14.99 470.376V470.366Z" />
      <path d="M144.08 470.456C141.22 469.556 139.09 468.276 134.22 464.606C127.73 459.696 100.17 438.706 84.25 426.546C23.31 380.076 19.81 377.346 11.83 370.136C6.41 365.226 3.98 362.286 1.84 358.016L0.26 354.816L0.13 330.156L0 305.496H1.88C3.71 305.496 3.76 305.536 6.66 309.426C8.32 311.606 11.87 315.656 14.55 318.476C23 327.226 25.64 329.316 75.36 366.736C87.82 376.126 106.34 390.116 116.54 397.846C126.74 405.616 139.8 415.516 145.56 419.866C151.32 424.216 161.18 431.686 167.49 436.506C173.81 441.326 185.5 450.246 193.52 456.346L208.07 467.436L208.2 469.266L208.33 471.056L177.05 471.016C153.03 471.016 145.39 470.886 144.06 470.466L144.08 470.456Z" />
      <path d="M227.5 446.006C214.95 436.486 197.07 422.916 187.81 415.876C171.34 403.376 119.02 364.116 104.17 353.066C100.07 350.036 91.5 343.716 85.18 338.986C78.82 334.296 69.73 327.596 64.95 324.046C29.23 297.716 23.77 293.406 15.62 284.916C8.19 277.236 3.93 270.616 1.32 262.936L0.0400009 259.056L0.130001 234.566L0.260001 210.116L2.18 209.986L4.1 209.856L8.03 215.746C12.64 222.746 17.46 228.636 23.26 234.356C30.69 241.696 36.28 246.306 54.24 259.656C66.74 268.916 150.47 331.776 161.99 340.476C166.21 343.676 172.96 348.756 176.93 351.786C180.94 354.816 190.41 362.026 198.05 367.786C205.69 373.586 214.99 380.626 218.75 383.486C222.51 386.346 228.48 390.916 231.98 393.556C239.02 398.886 268.76 421.596 273.16 424.966C274.7 426.156 280.93 430.896 287.03 435.546C297.83 443.786 298.12 444.036 298.25 445.616C298.42 447.836 297.65 448.556 292.57 450.996C283.44 455.396 277.68 457.606 267.61 460.636C262.57 462.126 256.22 463.366 253.4 463.366H250.33L227.5 445.996V446.006Z" />
      <path d="M321.55 423.986C319.93 422.746 314.59 418.656 309.64 414.896C304.73 411.136 294.53 403.336 287.02 397.616C248.36 368.006 182.81 318.756 136.17 284.196C108.86 263.966 93.41 252.616 76.64 240.416C67.04 233.416 56.75 225.866 53.81 223.606C23.21 200.176 5.16 172.316 0.680001 141.586C0.130001 137.656 0.0400009 128.866 0.0400009 76.8558C0.0400009 17.7958 0.0400013 16.6458 0.890001 13.9158C3.11 6.74583 8.66 1.92583 16.21 0.555832C18.86 0.085832 36.56 0.00583186 113.55 0.00583186C168.6 -0.0341681 211.7 0.135832 217.37 0.385832C245.45 1.62583 265.33 6.18583 284.15 15.7058C318.42 33.1158 338.98 60.6358 345.13 97.4658C345.73 101.266 345.9 104.466 345.9 114.106C345.9 124.686 345.77 126.696 344.92 131.516C342.96 142.316 340.95 148.496 336.3 158.056C330.67 169.616 326.49 175.296 315.95 185.576C309.25 192.146 305.62 194.966 295.85 201.236C293.42 202.776 291.58 204.176 291.8 204.396C291.97 204.566 294.06 205.466 296.41 206.406C313.22 213.146 327.43 222.406 339.55 234.446C359.99 254.846 371.21 279.896 373.9 311.046C374.45 317.446 374.2 334.046 373.47 340.276C371.21 359.096 365.19 377.616 356.57 392.426C350.77 402.366 344.84 409.876 335.15 419.776L328.79 426.266H326.61C324.65 426.266 324.18 426.056 321.53 424.006L321.55 423.986Z" />
    </svg>
  )
}

/** Saving the chart as a file. Drawn to the same 1.6 stroke as the others. */
export function DownloadMark() {
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
      <path d="M8 2v8" />
      <path d="M4.5 7L8 10.5 11.5 7" />
      <path d="M2.5 13h11" />
    </svg>
  )
}

