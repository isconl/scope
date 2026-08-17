# P3 · B2B Marketplace Portal & User-Group Mapping
**Version:** 1.0.0  
**Date:** 2026-08-17  
**Scope:** `dev.b2bexchange.co`, `dev.b2bplatform.co`, `dev-dashboard.wabbaglobal.org`, Regional & Global Competitor Benchmark  

---

## 1. System Architecture & Portal Division of Responsibility

| Portal / Surface | Domain | Target User Group | Core Interaction & Value Flow |
|---|---|---|---|
| **B2B Exchange** | `dev.b2bexchange.co` | Business Sellers, Buyers, Institutional Investors, Startups | **Deal Transactions:** Business sales, acquisitions, startup capital raises, asset liquidation. |
| **B2B Platform** | `dev.b2bplatform.co` | Enterprises, Suppliers, Manufacturers, Service Partners | **Partnerships & B2B Matchmaking:** Commercial joint ventures, supply chain sourcing, distributor agreements. |
| **Staff CRM & Ops Hub** | `dev-dashboard.wabbaglobal.org/auth` | Internal Staff: Brokers, Country Managers, Sourcing / HR, Testing | **Verification & Deal Execution:** KYC/KYB screening, deal dossier moderation, Country Manager assignment, CRM pipeline. |
| **Association Network** | `wamcaglobal.org` & Sister Sites | Industry Association Members, Corporate Executives | **Trust & Industry Authority:** Sector accreditation, executive directories, industry reports, events. |

---

## 2. Portal User Roles & Access Matrix

| Role Key | Role Name | Primary Interface | Capabilities & Workflow Boundaries |
|---|---|---|---|
| `user` / `client` | Registered Proposer / Counterparty | Exchange & Platform | Create deal listings, submit partnership proposals, view verified listings, sign intro agreements. |
| `broker` | Deal Broker / Account Rep | Staff CRM | Review pending deals, verify financial statements, match buyers with sellers, manage deal escrow. |
| `manager` | Country Manager (CM) | Staff CRM | Regional market leadership, localized deal origination, local advisor onboarding, regional compliance. |
| `sourcing` / `hr` | Sourcing Specialist / HR | Staff CRM / HR Portal | Candidate pipeline review (Advisors & Country Managers), structured interview screening, onboarding. |
| `tester` | QA & UX Tester | Jira + Dev Portals | Execute 17 user journeys, test account role switching, report blocking edge cases to Ragnar/Taylor. |

---

## 3. Global & Regional Competitor Benchmark (Jordan / Architect 10-Criteria Model)

Evaluated on a **100-Point Scale** across:
1. **Content Depth** (10)
2. **Information Architecture** (10)
3. **Visual & Brand Assets** (10)
4. **Member / Association Features** (10)
5. **Technical Baseline & Speed** (10)
6. **Match & Discovery Engine** (10)
7. **Profile & Listing Standard** (10)
8. **Trust & Verification Depth** (10)
9. **Monetisation Model** (10)
10. **Segmentation & Geography Overlap** (10)

### Key Competitor Categorization
- **Direct Global M&A / Business Sales Portals:** `acquire.com`, `empireflippers.com`, `businessesforsale.com`, `bizbuysell.com`, `bizquest.com`, `loopnet.com` (Commercial RE), `quietlight.com`, `dealstream.com`, `tworld.com`, `sunbeltnetwork.com`.
- **Tech / Fast Due Diligence & Aggregators:** `tiny.com` (2-week turnaround), `flippa.com`, `privsource.com`, `exitadvisor.io`, `exactdata.com` (lead database).
- **Investor & Partner Networks (European & MENA):** `aeryadvisors.com` (33k accredited investors, 200k global), `redgatecapital.eu`, `estban.ee`, `fundwise.me`, `invest.qa` (Qatar partner matching), `lusha.com`.
- **Regional Target Focus (Sam Strategic Directive 16 Aug):** Top-3 portals in **Egypt** & **Turkey** for localized Country Manager and deal origination recruitment.

---

## 4. Operational Directives & Action Items
1. **Zero Public Weakness:** Complete all testing journeys on `dev.b2bexchange.co` and `dev.b2bplatform.co` before production rollout to Country Managers.
2. **Infrastructure Edge:** Enforce Middle East / European CDN edge placement with Taylor and Ragnar to guarantee < 2.0s initial load for high-value counterparties.
3. **Candidate Screening Standard:** Deploy AI-assisted rubric for Olive's HR portal to screen incoming Advisor and Country Manager candidates.
