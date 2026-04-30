// Cortex compositor. One call → six phases → a structured `Thought`.
//
//   sensory  → resolve seeds + embed the question
//   memory   → recall semantic / declarative / episodic memories
//   limbic   → re-weight memories by social, recency, repetition affect
//   association → find strongest reasoning paths between seeds and memories
//   executive   → synthesise a one-sentence conclusion and confidence
//   motor       → propose concrete follow-up actions
//
// The compositor is the public entry point most callers should use; the
// individual phases are exported for finer-grained orchestration (e.g. tests
// that want to assert one phase's behaviour in isolation).

import { associate } from './association.js';
import { compose, plan } from './executive.js';
import { affect } from './limbic.js';
import { recall } from './memory.js';
import { actuate } from './motor.js';
import { perceive } from './sensory.js';
import type { CortexInput, Thought, ThoughtStep } from './types.js';

/**
 * Run the cortex pipeline end-to-end. The graph snapshot in `input.graph` is
 * read but never mutated. Cost is dominated by repeated `embed()` calls during
 * the memory phase, which is O(N * dim); for 5k-node graphs this stays under
 * 100ms on a modern CPU.
 */
export function think(input: CortexInput): Thought {
  const startedAt = Date.now();
  const trace: ThoughtStep[] = [];

  const sensory = perceive(input);
  trace.push(sensory.step);

  const memory = recall(input, sensory.questionEmbedding, sensory.seeds);
  trace.push(memory.step);

  const limbic = affect(memory.memories, input.brainState);
  trace.push(limbic.step);

  const association = associate(input, sensory.seeds, limbic.memories);
  trace.push(association.step);

  const executive = plan(
    sensory.question,
    sensory.seeds,
    limbic.memories,
    association.associations,
  );
  trace.push(executive.step);

  const motor = actuate(
    sensory.seeds,
    limbic.memories,
    association.associations,
    association.predictedLinks,
  );
  trace.push(motor.step);

  return compose(
    sensory.question,
    sensory.seeds,
    limbic.memories,
    association.associations,
    executive.conclusion,
    executive.confidence,
    trace,
    motor.actions,
    Date.now() - startedAt,
  );
}

export { perceive } from './sensory.js';
export { recall } from './memory.js';
export { affect } from './limbic.js';
export { associate } from './association.js';
export { plan } from './executive.js';
export { actuate } from './motor.js';
