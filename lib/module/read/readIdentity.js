"use strict";

import { compositeKey, semanticValue } from "../core/serialize.js";

/** Canonical semantic descriptors preserve object identity only where leaf values require it. */
export const incrementalSignature = (kind, ...values) => compositeKey(kind, ...values.map(semanticValue));
//# sourceMappingURL=readIdentity.js.map