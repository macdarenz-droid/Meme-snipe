/** The "Slot" mark from brand/zeroed-mark.svg, in currentColor. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M48 256A208 208 0 1 1 464 256A208 208 0 1 1 48 256ZM144 145.5L348 145.5L361.081 177.081L208.663 329.5L368 329.5L368 366.5L164 366.5L150.919 334.919L303.337 182.5L144 182.5Z"
      />
    </svg>
  );
}

export function Lockup() {
  return (
    <span className="lockup">
      <Mark size={22} />
      <span className="wordmark">Zeroed</span>
    </span>
  );
}
