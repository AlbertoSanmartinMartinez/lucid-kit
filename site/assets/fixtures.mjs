// SPDX-License-Identifier: Apache-2.0
// Made by site/tools/fixtures.mjs: run it again for new ones rather than editing this file.

/** An event signed by an agent, as a hub receives it. */
export const demoEnvelope = {
  "event": {
    "specversion": "1.0",
    "id": "4c8971a1-994c-49ad-bb38-8c3b07f45656",
    "source": "did:key:z6MkkHbiABQUoXDUTJiC8YoNS5Lp1rZF2buRRd3UnopZgWva",
    "type": "dev.rust.code-review.request",
    "time": "2026-11-20T08:23:40.412Z",
    "datacontenttype": "application/json",
    "subject": "dev.rust.code-review.requests",
    "dataschema": "https://hub.example/v1/topics/dev.rust.code-review.requests/schema",
    "data": {
      "repo": "https://github.com/acme/parser",
      "pr": 42
    }
  },
  "proof": {
    "algorithm": "Ed25519",
    "canonicalization": "JCS",
    "context": "agenthub/event/v1",
    "key_id": "did:key:z6MkkHbiABQUoXDUTJiC8YoNS5Lp1rZF2buRRd3UnopZgWva",
    "signature": "pfiOYwFQi8YW0ORY-3z94T4DF2o3_j0auyFc2y3Iuu7lX4lCCZgC5K-47Hn8rx2nTgGwbJwzDmyCD5nathxuCg"
  }
};

/** The checkpoint of a hub's log, signed by the hub and cosigned by a witness, as GET /v1/log/note serves it. */
export const checkpointNote = "did:key:z6Mkih8doYBMrUmSsA7pHC3dZWetN4gV4UijR2NCTtDyHq32\n6\n/1N30bTAipvN7PSOo3c7niRl2UVn4NwgyOoQwR+WI8g=\n\n— did:key:z6Mkih8doYBMrUmSsA7pHC3dZWetN4gV4UijR2NCTtDyHq32 RoMBaxbivud8YkmkKHqVrbu4s+whNU+NmWPz/MNjYOVcMxNB/hWt49/2JADS0kV5geH73yOlOlhACsd3qrNPwO+n3wE=\n— witness.example/w1 0lmixwAAAABrAAOMvqZETXqUY6VQ++/3XHN5GpkFk8Pg3Z13BdGY/h2xYz29N2UnI1zaS2nOuw2+/dvPhJkVjQxqFo8O1s/8sylKCg==\n";

/** The key that witness cosigns with, as it prints it: what a client that trusts it is given. */
export const witnessVerifier = "witness.example/w1+d259a2c7+BLCIT4Lk+r2ktCAddJcYOe+LheZRH/GCvqIwFvku+N9+";
