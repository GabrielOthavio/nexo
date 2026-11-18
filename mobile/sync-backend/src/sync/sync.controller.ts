import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsuarioAtual } from '../common/decorators/usuario-atual.decorator';
import { UsuarioAutenticado } from '../auth/jwt.strategy';
import { SyncService } from './sync.service';
import { SyncPushDto } from './dto/sync-push.dto';

@Controller('sync')
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /**
   * `X-Device-Id` identifica a INSTALAÇÃO do app que está empurrando a cadeia
   * (ver dispositivoId.ts no app). É obrigatório: a âncora de continuidade da
   * cadeia de hashes é por (usuário, dispositivo), então sem ele não há como
   * saber contra qual cadeia validar o lote. Validado à mão em vez de no DTO
   * porque o ValidationPipe global (main.ts) só enxerga o corpo da
   * requisição, não headers — e um header ausente aqui é erro do cliente
   * (400), não uma falha parcial de lote a ser reportada em `motivoParada`.
   */
  @Post('push')
  push(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: SyncPushDto,
    @Headers('x-device-id') dispositivoId: string,
  ) {
    if (typeof dispositivoId !== 'string' || dispositivoId.trim().length === 0) {
      throw new BadRequestException('Header X-Device-Id ausente ou vazio.');
    }
    return this.syncService.push(usuario, dto, dispositivoId.trim());
  }

  /** Lista leve (sem etapas) para a tela de seleção de auditoria no app. */
  @Get('auditorias')
  listarAuditorias(@UsuarioAtual() usuario: UsuarioAutenticado) {
    return this.syncService.listarAuditorias(usuario);
  }

  /** Sob demanda, só depois que o auditor seleciona a auditoria — ver plano de integração. */
  @Get('auditorias/:uuid/etapas')
  listarEtapas(@UsuarioAtual() usuario: UsuarioAutenticado, @Param('uuid') uuid: string) {
    return this.syncService.listarEtapas(usuario, uuid);
  }
}
