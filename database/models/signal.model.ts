import { Schema, model, models, type Document, type Model } from 'mongoose';

// A Signal is one alert-worthy event we detected for a symbol during a scan.
// We persist them to (a) dedup so we don't spam the same signal repeatedly,
// and (b) keep a short history for tuning thresholds later.

export type SignalSource = 'reddit' | 'stocktwits' | 'twitter' | 'movers';
export type SignalDirection = 'up' | 'down' | 'neutral';

export interface SignalDoc extends Document {
  symbol: string;
  /** Which detector produced this: social buzz vs price mover. */
  sources: SignalSource[];
  direction: SignalDirection;
  /** Aggregate score used for ranking (higher = more notable). */
  score: number;
  /** How many social mentions we counted this scan. */
  mentions: number;
  /** Price % change if a mover signal, else null. */
  changePercent?: number | null;
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
    summary: { type: String, default: '' },
    dedupKey: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

export const Signal: Model<SignalDoc> =
  (models?.Signal as Model<SignalDoc>) || model<SignalDoc>('Signal', SignalSchema);
