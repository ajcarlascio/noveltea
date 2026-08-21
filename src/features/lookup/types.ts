/**
 * Word lookup, behind one interface so the interface does not know or care whether
 * an answer came from this device or from somewhere else.
 *
 * That matters for more than tidiness: the offline provider is always available and
 * the networked ones are gated on consent, so the *availability* of a provider is
 * the only thing the UI should reason about.
 */

export type LookupKind = "synonym" | "related" | "rhyme";

export interface LookupResult {
  /** The word that was asked about, normalised. */
  word: string;
  kind: LookupKind;
  words: string[];
  /** Shown to the author, so they know whether this answer left the device. */
  source: string;
  /** True when producing this result sent something to a third party. */
  wasNetworked: boolean;
}

export interface LookupProvider {
  readonly id: string;
  readonly kinds: readonly LookupKind[];
  /** False when unconfigured, unconsented, or still loading its data. */
  available(): boolean;
  look(word: string, kind: LookupKind): Promise<LookupResult>;
}
