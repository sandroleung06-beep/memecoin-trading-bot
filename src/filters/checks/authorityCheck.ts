import type { FilterConfig } from "../../config/filters.js";
import type { CheckResult, FilterCheck, TokenCandidate } from "../types.js";

/** Rejects tokens whose mint (infinite supply) or freeze (wallet lock) authority is still live. */
export function authorityCheck(
  config: Pick<FilterConfig, "REQUIRE_MINT_AUTHORITY_REVOKED" | "REQUIRE_FREEZE_AUTHORITY_REVOKED">,
): FilterCheck {
  return {
    name: "authority",
    kind: "static",
    run(candidate: TokenCandidate): CheckResult {
      const mintAuthorityRevoked = candidate.mintAuthority === null;
      const freezeAuthorityRevoked = candidate.freezeAuthority === null;
      const reasons: string[] = [];
      if (config.REQUIRE_MINT_AUTHORITY_REVOKED && !mintAuthorityRevoked) {
        reasons.push(`MINT_AUTHORITY_ACTIVE: authority=${candidate.mintAuthority}`);
      }
      if (config.REQUIRE_FREEZE_AUTHORITY_REVOKED && !freezeAuthorityRevoked) {
        reasons.push(`FREEZE_AUTHORITY_ACTIVE: authority=${candidate.freezeAuthority}`);
      }
      return { passed: reasons.length === 0, reasons, metrics: { mintAuthorityRevoked, freezeAuthorityRevoked } };
    },
  };
}
