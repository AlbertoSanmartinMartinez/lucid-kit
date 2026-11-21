# SPDX-License-Identifier: Apache-2.0
# Mutations of: an agent as an OASF record, for the AGNTCY Directory (section 29).
# Run from anywhere: python3 experiments/mutations/oasf.py [text of one description]
from harness import run

mutations = [
    ('src/core/oasf.mjs', "  if (!verdict.ok) throw new Error('an OASF record is made from an A2A card signed by its agent');\n", "  if (!verdict.ok) return {};\n", 'record of an unsigned card'),
    ('src/core/oasf.mjs', "(atLeastOne && given.length === 0)", "false", 'no skills'),
    ('src/core/oasf.mjs', "!CLASS_RE.test(name)", "false", 'skills that are not of the taxonomy'),
    ('src/core/oasf.mjs', "if (id !== undefined && !(Number.isSafeInteger(id) && id > 0))", "if (false)", 'ids that are not ids'),
    ('src/core/oasf.mjs', "authors.length < 1 || ", "", 'no authors'),
    ('src/core/oasf.mjs', "if (owner !== undefined && !(isValidDid(owner) || /^did:web:[A-Za-z0-9.:%_-]{1,200}$/.test(owner)))", "if (false)", 'an owner that is not a DID'),
    ('src/core/oasf.mjs', "if (!DATETIME_RE.test(a2a.version) || Number.isNaN(Date.parse(a2a.version)))", "if (false)", 'no date'),
    # Not here: taking the identity from another interface of the card than the one that verified. A card that
    # verifies has one interface, so no test can tell the two apart: the change is the same program.
    ('src/sdk/index.mjs', "    if (!card) throw new Error('this hub has no A2A card for that agent to write a record around');\n", "", 'sdk: record without a card'),
    ('src/sdk/index.mjs', "owner: owner ?? agent.controller?.did });", "owner });", 'sdk: controller not named'),
]

run(mutations, ['test/oasf.test.mjs'], test_timeout_ms=60000)
