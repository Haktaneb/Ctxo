import { MAX_LOANS } from '../lending/loan-limit.js';

export function describeLimit(title: string): string {
  return title + ' can be borrowed with up to ' + MAX_LOANS + ' other books';
}
