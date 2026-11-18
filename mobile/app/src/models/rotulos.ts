/**
 * Rótulos de exibição dos códigos que o Django guarda (`situacao` da Etapa,
 * `status` da Auditoria). As telas mostravam o código cru (`EM_ANDAMENTO`),
 * linguagem de sistema em vez da do usuário — o mesmo defeito (heurística H2)
 * que a inspeção apontou nos sistemas analisados. Um único lugar para o
 * formulário de etapa e para as listas, para a mesma situação não aparecer
 * grafada de dois jeitos.
 */
export const SITUACOES_ETAPA = [
  { valor: 'PENDENTE', rotulo: 'Pendente' },
  { valor: 'EM_ANDAMENTO', rotulo: 'Em andamento' },
  { valor: 'CONCLUIDA', rotulo: 'Concluída' },
  { valor: 'REABERTA', rotulo: 'Reaberta' },
] as const;

const STATUS_AUDITORIA: Record<string, string> = {
  PLANEJADA: 'Planejada',
  EM_ANDAMENTO: 'Em andamento',
  CONCLUIDA: 'Concluída',
  CANCELADA: 'Cancelada',
};

/** Código desconhecido (valor novo no servidor) aparece como veio, em vez de sumir. */
export function rotuloSituacaoEtapa(codigo: string | null | undefined): string {
  if (!codigo) return '';
  return SITUACOES_ETAPA.find((s) => s.valor === codigo)?.rotulo ?? codigo;
}

/** "2026-09-07" (formato do banco) -> "07/09/2026". Outro formato passa como veio. */
export function formatarData(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export function rotuloStatusAuditoria(codigo: string | null | undefined): string {
  if (!codigo) return '';
  return STATUS_AUDITORIA[codigo] ?? codigo;
}
