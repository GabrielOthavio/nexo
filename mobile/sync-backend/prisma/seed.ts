import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const senhaHash = await bcrypt.hash('mudar123', 10);

  // djangoUsuarioUuid é um placeholder — substitua pelo id_unico real do
  // Usuario correspondente no Django. Veja:
  //   python manage.py vincular_usuario_mobile <username>
  await prisma.usuario.upsert({
    where: { username: 'auditor.campo' },
    update: {},
    create: {
      username: 'auditor.campo',
      senhaHash,
      nomeCompleto: 'Auditor de Campo (seed)',
      perfil: 'Funcionário',
      unidade: null, // sem restrição de unidade, ajuste conforme necessário
      djangoUsuarioUuid: '00000000-0000-0000-0000-000000000000',
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    'Seed concluído: usuário "auditor.campo" (senha: mudar123) criado. ' +
    'Rode "python manage.py vincular_usuario_mobile <username>" no Django e ' +
    'atualize django_usuario_uuid antes de usar de verdade.',
  );
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
