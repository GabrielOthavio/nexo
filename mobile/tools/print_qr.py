import sys
import io
import qrcode

# Console do Windows costuma usar cp1252 por padrão, que não tem os
# caracteres de bloco Unicode (█) usados por print_ascii — força UTF-8
# na saída padrão para evitar UnicodeEncodeError.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

url = sys.argv[1]
qr = qrcode.QRCode(border=1)
qr.add_data(url)
qr.make()
qr.print_ascii(invert=True)
print(url)
