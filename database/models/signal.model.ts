import { Schema, model, models, type Document, type Model } from 'mongoose';

// A Signal is one alert-worthy event we detected for a symbol during a scan.
// We persist them to (a) dedup so we don't spam the same signal repeatedly,
// and (b) keep a short history for tuning thresholds later.

export type SignalDirection = 'up' | 'down' | 'neutral';

export interface SignalDoc extends Document {
  symbol: string;
  /** Which detectors contributed: social buzz, movers, volume, insider, filing, news. */
  sources: string[];
  direction: SignalDirection;
  /** Aggregate score used for ranking (higher = more notable). */
  score: number;
  /** How many social/news mentions we counted this scan. */
  mentions: number;
  /** Price % change if a mover signal, else null. */
  changePercent?: number | null;
  /** Today's volume vs. its recent average (e.g. 3.2), else null. */
  volumeRatio?: number | null;
  /** Human-readable catalysts (news headlines, insider filings). */
  catalysts: string[];
  /** Short LLM-written summary of why this is notable. */
  summary: string;
  /** Dedup key = symbol + coarse time bucket + direction. */
  dedupKey: string;
  createdAt: Date;
}

const SignalSchema = new Schema<SignalDoc>(
  {
    symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
    sources: { type: [String], required: true, default: [] },
    direction: { type: String, required: true, default: 'neutral' },
    score: { type: Number, required: true, default: 0 },
    mentions: { type: Number, required: true, default: 0 },
    changePercent: { type: Number, default: null },
    volumeRatio: { type: Number, default: null },
    catalysts: { type: [String], default: [] },
    summary: { type: String, default: '' },
    dedupKey: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

export const Signal: Model<SignalDoc> =
  (models?.Signal as Model<SignalDoc>) || model<SignalDoc>('Signal', SignalSchema);
