import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind class merge (RNR helper); adapter-internal, never used by screens. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
