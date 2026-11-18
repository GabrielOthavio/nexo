-- CreateEnum
CREATE TYPE "Unidade" AS ENUM ('SEFAZ', 'SESAU', 'SEINFRA', 'SEMA', 'SEAD', 'SEDUC', 'SESP', 'SEAG', 'SEJEL', 'SEDU', 'OUTRO');

-- CreateTable
CREATE TABLE "usuarios" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "senha_hash" TEXT NOT NULL,
    "nome_completo" TEXT NOT NULL,
    "perfil" TEXT NOT NULL,
    "unidade" "Unidade",
    "django_usuario_uuid" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ancoras_dispositivo" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "dispositivo_id" TEXT NOT NULL,
    "ultimo_hash_confirmado" TEXT,
    "ultimo_abandonado_uuid" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ancoras_dispositivo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mapeamentos_uuid_temporario" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "uuid_temporario" TEXT NOT NULL,
    "uuid_django" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mapeamentos_uuid_temporario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lotes_sincronizacao" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "total_itens" INTEGER NOT NULL,
    "itens_confirmados" INTEGER NOT NULL,
    "hash_chain_ok" BOOLEAN NOT NULL,
    "recebido_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lotes_sincronizacao_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_uuid_key" ON "usuarios"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_username_key" ON "usuarios"("username");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_django_usuario_uuid_key" ON "usuarios"("django_usuario_uuid");

-- CreateIndex
CREATE UNIQUE INDEX "ancoras_dispositivo_usuario_id_dispositivo_id_key" ON "ancoras_dispositivo"("usuario_id", "dispositivo_id");

-- CreateIndex
CREATE UNIQUE INDEX "mapeamentos_uuid_temporario_usuario_id_uuid_temporario_key" ON "mapeamentos_uuid_temporario"("usuario_id", "uuid_temporario");

-- CreateIndex
CREATE UNIQUE INDEX "lotes_sincronizacao_uuid_key" ON "lotes_sincronizacao"("uuid");

-- AddForeignKey
ALTER TABLE "ancoras_dispositivo" ADD CONSTRAINT "ancoras_dispositivo_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapeamentos_uuid_temporario" ADD CONSTRAINT "mapeamentos_uuid_temporario_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lotes_sincronizacao" ADD CONSTRAINT "lotes_sincronizacao_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
