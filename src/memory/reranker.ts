/**
 * Reranker for Memory Search Results
 *
 * Uses toxe (SentencePiece tokenizer) + ONNX cross-encoder model
 * to rerank search results for better relevance.
 *
 * Based on twinnydotdev/twinny's reranker.ts
 */

import { Toxe } from 'toxe';
import * as ort from 'onnxruntime-node';
import { join } from 'path';
import { existsSync } from 'fs';

import { logger } from '../utils/logger.js';
import { MIA_DIR } from '../constants/paths.js';

const MODELS_DIR = join(MIA_DIR, 'models');

export interface RankedResult {
  content: string;
  score: number;
  originalIndex: number;
}

export class Reranker {
  private tokenizer: Toxe | null = null;
  private session: ort.InferenceSession | null = null;
  private modelPath: string;
  private tokenizerPath: string;
  private initialized = false;

  /**
   * In-flight init promise.  Any concurrent call to init() while a load is
   * already in progress receives the *same* promise rather than launching a
   * second parallel model load.  Set to null after the load finishes (whether
   * it succeeded or failed) so a future explicit retry can re-attempt.
   */
  private initPromise: Promise<boolean> | null = null;

  constructor() {
    this.modelPath = join(MODELS_DIR, 'reranker.onnx');
    this.tokenizerPath = join(MODELS_DIR, 'spm.model');
  }

  /**
   * Initialize the reranker (lazy loading).
   *
   * Concurrent callers share a single in-flight promise so the ONNX model is
   * never loaded more than once.
   */
  async init(): Promise<boolean> {
    if (this.initialized) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInit().finally(() => {
      // Clear so a retry can re-enter _doInit after a prior failure.
      this.initPromise = null;
    });

    return this.initPromise;
  }

  /**
   * Internal one-shot init logic.  Only called via init() which serialises
   * concurrent callers with the initPromise gate above.
   */
  private async _doInit(): Promise<boolean> {
    try {
      // Check if models exist
      if (!existsSync(this.modelPath) || !existsSync(this.tokenizerPath)) {
        logger.debug(
          { modelPath: this.modelPath, tokenizerPath: this.tokenizerPath },
          '[Reranker] Models not found — using keyword fallback'
        );
        return false;
      }

      logger.debug({ modelPath: this.modelPath }, '[Reranker] Loading ONNX cross-encoder model');
      await Promise.all([this.loadModel(), this.loadTokenizer()]);
      this.initialized = true;
      logger.debug('[Reranker] Cross-encoder loaded successfully');
      return true;
    } catch (error) {
      logger.warn({ err: error }, '[Reranker] Failed to initialize reranker');
      return false;
    }
  }

  /**
   * Rerank search results based on query relevance
   */
  async rerank(query: string, results: string[]): Promise<RankedResult[]> {
    // Try to use the cross-encoder model
    const probabilities = await this.getRankScores(query, results);

    if (probabilities) {
      // Sort by score descending
      return results
        .map((content, index) => ({
          content,
          score: probabilities[index],
          originalIndex: index,
        }))
        .sort((a, b) => b.score - a.score);
    }

    // Fallback: use simple keyword matching
    return this.fallbackRerank(query, results);
  }

  /**
   * Get ranking scores from the cross-encoder model
   */
  private async getRankScores(query: string, samples: string[]): Promise<number[] | null> {
    if (!this.initialized) {
      const ok = await this.init();
      if (!ok) return null;
    }

    try {
      const ids = await this.tokenizer?.encode(query, samples);
      if (!ids?.length) return null;

      const inputTensor = this.getInputTensor(ids, samples.length);
      const attentionMaskTensor = this.getAttentionMaskTensor(ids.length, samples.length);

      const output = await this.session?.run({
        input_ids: inputTensor,
        attention_mask: attentionMaskTensor,
      });

      if (!output) return null;

      const logits = await this.getLogits(output);
      return this.softmax(logits);
    } catch (error) {
      logger.warn({ err: error }, '[Reranker] Reranking failed — falling back to keyword match');
      return null;
    }
  }

  /**
   * Fallback reranking using keyword matching
   */
  private fallbackRerank(query: string, results: string[]): RankedResult[] {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

    return results
      .map((content, index) => {
        const contentLower = content.toLowerCase();
        let score = 0;

        for (const term of queryTerms) {
          if (contentLower.includes(term)) {
            score += 1;
            // Bonus for exact word match
            if (new RegExp(`\\b${term}\\b`).test(contentLower)) {
              score += 0.5;
            }
          }
        }

        // Normalize score
        score = queryTerms.length > 0 ? score / queryTerms.length : 0;

        return {
          content,
          score,
          originalIndex: index,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  private getInputTensor(ids: number[], sampleCount: number): ort.Tensor {
    const inputIds = ids.map(BigInt);
    return new ort.Tensor('int64', BigInt64Array.from(inputIds), [
      sampleCount,
      inputIds.length / sampleCount,
    ]);
  }

  private getAttentionMaskTensor(inputLength: number, sampleCount: number): ort.Tensor {
    return new ort.Tensor('int64', new BigInt64Array(inputLength).fill(1n), [
      sampleCount,
      inputLength / sampleCount,
    ]);
  }

  private async getLogits(output: ort.InferenceSession.OnnxValueMapType): Promise<number[]> {
    const data = await (output.logits as ort.Tensor).getData();
    return Array.prototype.slice.call(data);
  }

  private softmax(logits: number[]): number[] {
    const maxLogit = Math.max(...logits);
    const scores = logits.map(l => Math.exp(l - maxLogit));
    const sum = scores.reduce((a, b) => a + b, 0);
    return scores.map(s => s / sum);
  }

  private async loadModel(): Promise<void> {
    logger.debug({ modelPath: this.modelPath }, '[Reranker] Loading model file');
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
    });
    logger.debug('[Reranker] Model file loaded');
  }

  private async loadTokenizer(): Promise<void> {
    logger.debug({ tokenizerPath: this.tokenizerPath }, '[Reranker] Loading tokenizer');
    this.tokenizer = new Toxe(this.tokenizerPath);
    logger.debug('[Reranker] Tokenizer loaded');
  }
}

// Singleton instance
let rerankerInstance: Reranker | null = null;

export function getReranker(): Reranker {
  if (!rerankerInstance) {
    rerankerInstance = new Reranker();
  }
  return rerankerInstance;
}
