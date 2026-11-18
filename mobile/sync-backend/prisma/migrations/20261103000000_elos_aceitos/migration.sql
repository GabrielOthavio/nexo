-- CreateTable
CREATE TABLE "elos_aceitos" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "dispositivo_id" TEXT NOT NULL,
    "uuid_operacao" TEXT NOT NULL,
    "hash_atual" TEXT NOT NULL,
    "aceito_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "elos_aceitos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "elos_aceitos_usuario_id_dispositivo_id_uuid_operacao_key" ON "elos_aceitos"("usuario_id", "dispositivo_id", "uuid_operacao");

-- AddForeignKey
ALTER TABLE "elos_aceitos" ADD CONSTRAINT "elos_aceitos_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

