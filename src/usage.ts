/**
 * Compteur d'usage minimal, en mémoire. Objectif : avoir une vue jour par jour
 * sur "K-Phi sert-il à quelque chose en public" sans attendre un vrai stack
 * d'analytics. À remplacer par Postgres (une ligne par événement, ou un
 * agrégat par jour) dès que le volume ou le besoin d'historique le justifie —
 * ce compteur repart à zéro à chaque redéploiement.
 */

export type EventName =
  | "tool_call:kphi_analyze_ledger"
  | "tool_call:kphi_request_upload"
  | "tool_call:kphi_get_analysis"
  | "tool_call:kphi_explain_kpi"
  | "analysis_ready"
  | "analysis_error"
  | "rate_limited"
  | "upload_unavailable"  // kphi_request_upload appelé alors que KPHI_UPLOAD_STORAGE est absent :
                          // mesure la demande réelle pour l'upload volumineux avant de le construire
  /* ── Télémétrie de mapping : la matière du feedback loop. Chaque compteur
     répond à une question produit : adopted élevé → synonymes à enrichir
     (les fichiers réels portent des en-têtes qu'on ne connaît pas) ;
     demoted → des exports mettent des mémos là où on attend des intitulés ;
     column_map_override → l'inférence s'est trompée et l'appelant a corrigé
     (regarder les analyses concernées : le plan corrigé est dans le store) ;
     needs_input → des fichiers sans dates arrivent vraiment. ── */
  | "acct_name:adopted"
  | "acct_name:demoted"
  | "column_map_override"
  | "needs_input"
  | "genre:ledger"
  | "genre:trial_balance"
  | "genre:unknown"
  | "report_view"        // ouverture du dashboard /a/:id (avant le clic app)
  | "conversion_click";   // clic sur open_in_kphi_url (voir server.ts, redirect /a/:id)

interface DayBucket { [event: string]: number }

export class UsageCounter {
  private days = new Map<string, DayBucket>(); // "2026-08-25" -> counts
  private startedAt = new Date();

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  record(event: EventName, n = 1) {
    const key = this.today();
    let bucket = this.days.get(key);
    if (!bucket) { bucket = {}; this.days.set(key, bucket); }
    bucket[event] = (bucket[event] ?? 0) + n;
    // Garde-fou mémoire : ne conserve que les 90 derniers jours.
    if (this.days.size > 90) {
      const oldest = [...this.days.keys()].sort()[0];
      this.days.delete(oldest);
    }
  }

  snapshot() {
    const totals: DayBucket = {};
    for (const bucket of this.days.values())
      for (const [k, v] of Object.entries(bucket)) totals[k] = (totals[k] ?? 0) + v;

    const byDay = [...this.days.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, counts]) => ({ date, ...counts }));

    const analyses = totals["tool_call:kphi_analyze_ledger"] ?? 0;
    const conversions = totals["conversion_click"] ?? 0;

    return {
      since: this.startedAt.toISOString(),
      totals,
      by_day: byDay,
      conversion_rate: analyses > 0 ? Number((conversions / analyses).toFixed(3)) : null,
    };
  }
}
