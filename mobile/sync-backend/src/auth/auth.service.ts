import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

const HASH_FANTASMA = '$2b$10$1GaUHYb7NDMNznT7ONlQnuFgvO1iFiG6YqwkG/7N91lwt56Yr3IEu';
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(username: string, password: string) {
    const usuario = await this.prisma.usuario.findUnique({ where: { username } });
    
    const senhaValida = await bcrypt.compare(password, usuario?.senhaHash ?? HASH_FANTASMA);

    if (!usuario || !usuario.ativo || !senhaValida) {
      throw new UnauthorizedException('Usuário ou senha inválidos.');
    }

    const accessToken = await this.jwt.signAsync({ sub: usuario.id, username: usuario.username });

    return {
      accessToken,
      usuario: {
        usuarioId: usuario.id,
        username: usuario.username,
        unidade: usuario.unidade,
        perfil: usuario.perfil,
      },
    };
  }
}
