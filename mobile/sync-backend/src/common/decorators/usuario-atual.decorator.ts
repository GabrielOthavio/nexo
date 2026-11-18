import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UsuarioAutenticado } from '../../auth/jwt.strategy';

/** Extrai o usuário já validado pelo JwtStrategy (request.user). */
export const UsuarioAtual = createParamDecorator(
  (_dados: unknown, ctx: ExecutionContext): UsuarioAutenticado => {
    return ctx.switchToHttp().getRequest().user;
  },
);
