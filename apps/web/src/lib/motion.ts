import type { Transition } from 'motion/react';

/** One spring for panels and sheets: quick, no visible bounce. */
export const spring: Transition = { type: 'spring', stiffness: 420, damping: 40, mass: 0.9 };

export const page: Transition = { duration: 0.18, ease: [0.2, 0, 0, 1] };
