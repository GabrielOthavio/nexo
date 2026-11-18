import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export interface JwtPayload {
  sub: number;
  username: string;
}

export interface UsuarioAutenticado {
  id: number;
  username: string;
  perfil: string;
  unidade: string | null;
  /**
   * Usuario.id_unico do núcleo Django — sempre derivado aqui, no servidor,
   * a partir do usuário já autenticado pelo JWT. Nunca deve ser aceito como
   * campo vindo do corpo/query de uma requisição do app (ver decisão
   * "confused deputy" no plano de integração): repassar um valor
   * client-supplied permitiria a um app autenticado agir como outro auditor.
   */
  djangoUsuarioUuid: string;
  // A âncora da cadeia de hashes NÃO vive mais aqui: passou a ser por
  // (usuário, dispositivo) em AncoraDispositivo, resolvida dentro de
  // SyncService.push a partir do header X-Device-Id — a identidade do
  // usuário sozinha não identifica uma cadeia (ver schema.prisma).
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('SYNC_JWT_SECRET'),
    });
  }

  /**
   * Sempre revalida contra o banco (não confia apenas nas claims do token)
   * — perfil e unidade podem ter mudado desde a emissão do token, e o RBAC
   * precisa refletir o estado atual, não o estado no momento do login.
   */
  async validate(payload: JwtPayload): Promise<UsuarioAutenticado> {
    const usuario = await this.prisma.usuario.findUnique({ where: { id: payload.sub } });
    if (!usuario || !usuario.ativo) {
      throw new UnauthorizedException('Usuário inativo ou não encontrado.');
    }
    return {
      id: usuario.id,
      username: usuario.username,
      perfil: usuario.perfil,
      unidade: usuario.unidade,
      djangoUsuarioUuid: usuario.djangoUsuarioUuid,
    };
  }
}
