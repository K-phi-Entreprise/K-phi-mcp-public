/**
 * Stockage des uploads volumineux — backend fichier.
 *
 * Pourquoi un backend FICHIER suffit ici : le fichier est consommé quelques
 * secondes après le PUT (l'analyse démarre immédiatement) et c'est le
 * RÉSULTAT d'analyse qui persiste, pas le fichier. La durabilité objet
 * (S3/R2) n'apporte rien au funnel tant qu'on n'offre pas de reprise
 * différée — le jour où on l'offre, ce module gagne un second backend
 * derrière la même interface, sans toucher les routes.
 *
 * KPHI_UPLOAD_STORAGE :
 *   (non défini)   → upload désactivé (refus honnête, cf. PR #1)
 *   "mock"         → route active, MockEngine.analyzeFromStorage (tests locaux)
 *   "tmp"          → fichiers sous <os.tmpdir()>/kphi-uploads
 *   "tmp:/chemin"  → fichiers sous /chemin
 *   autre valeur   → considéré NON configuré (avertissement au boot) : on ne
 *                    prend jamais un fichier qu'on ne saura pas relire.
 */
import { mkdir, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface UploadStorage {
  save(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  /** Supprime les fichiers plus vieux que maxAgeMs. Retourne le nombre purgé. */
  sweep(maxAgeMs: number): Promise<number>;
}

/* Une clé est un identifiant, pas un chemin : tout séparateur ou caractère
   hors [A-Za-z0-9._-] est réécrit. "uploads/an_x" et "uploads%2Fan_x"
   convergent vers le même nom de fichier plat. */
export function safeName(key: string): string {
  return String(key).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "_";
}

export class FsUploadStorage implements UploadStorage {
  constructor(public dir: string) {}
  private path(key: string) { return join(this.dir, safeName(key)); }
  async save(key: string, data: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(key), data);
  }
  async read(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
  async sweep(maxAgeMs: number): Promise<number> {
    let purged = 0;
    let names: string[] = [];
    try { names = await readdir(this.dir); } catch { return 0; }
    const cutoff = Date.now() - maxAgeMs;
    for (const n of names) {
      try {
        const s = await stat(join(this.dir, n));
        if (s.mtimeMs < cutoff) { await rm(join(this.dir, n), { force: true }); purged++; }
      } catch { /* fichier disparu entre readdir et stat : rien à faire */ }
    }
    return purged;
  }
}

export interface UploadStorageSetup {
  kind: "disabled" | "mock" | "tmp";
  storage?: FsUploadStorage;
  note: string;  // pour le log de boot
}

export function createUploadStorage(spec: string | undefined): UploadStorageSetup {
  if (!spec) return { kind: "disabled", note: "désactivé (KPHI_UPLOAD_STORAGE non défini)" };
  if (spec === "mock") return { kind: "mock", note: "mock (routage seulement, moteur mock)" };
  if (spec === "tmp" || spec.startsWith("tmp:")) {
    const dir = spec === "tmp" ? join(tmpdir(), "kphi-uploads") : spec.slice(4);
    return { kind: "tmp", storage: new FsUploadStorage(dir), note: `fichiers sous ${dir} (TTL 24 h)` };
  }
  return { kind: "disabled", note: `valeur « ${spec} » non reconnue → upload DÉSACTIVÉ (backends : mock, tmp, tmp:/chemin)` };
}
