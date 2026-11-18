import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';

/** Um elo da cadeia de hashes, exatamente como persistido no dispositivo
 * (payload em texto plano — é o que foi hasheado; ver hash-chain.util.ts). */
export class ItemPushDto {
  @IsString()
  @IsNotEmpty()
  uuid: string;

  /** JSON serializado dos campos de negócio — exatamente o que foi hasheado no dispositivo. */
  @IsString()
  @IsNotEmpty()
  payload: string;

  @IsString()
  @IsNotEmpty()
  criadoEm: string;

  @Matches(/^[0-9a-f]{64}$/, { message: 'hashAnterior deve ser um SHA-256 em hex minúsculo.' })
  hashAnterior: string;

  @Matches(/^[0-9a-f]{64}$/, { message: 'hashAtual deve ser um SHA-256 em hex minúsculo.' })
  hashAtual: string;

  /**
   * Operação DESCARTADA pelo auditor no dispositivo: o elo continua no lote —
   * a cadeia é estritamente contígua e não admite buraco —, mas o servidor não
   * deve aplicar nada dela no Django; só validar o hash e avançar a âncora,
   * devolvendo o uuid em `abandonados` (ver SyncService.push). Opcional por
   * compatibilidade com apps em versões anteriores a este campo.
   */
  @IsOptional()
  @IsBoolean()
  abandonada?: boolean;
}

export class SyncPushDto {
  @IsArray()
  // Um push vazio não tem o que validar nem o que aplicar: hoje ele apenas
  // reescreveria a âncora no mesmo valor e registraria um LoteSincronizacao
  // sem conteúdo. Recusar na borda é mais barato e mais claro que tratar o
  // caso degenerado lá dentro.
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ItemPushDto)
  itens: ItemPushDto[];
}
