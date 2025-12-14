// routes/print-qr-codes.mts
import { Router } from "express";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";

const router = Router();

router.post("/print", async (req, res) => {
  try {
    const { ids } = req.body as { ids: string[] };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "No QR codes provided" });
    }

    const doc = new PDFDocument({
      size: "LETTER",
      margin: 36,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="qr-codes.pdf"`);
    doc.pipe(res);

    const cardWidth = 3.375 * 72;
    const cardHeight = 2.125 * 72;
    const cols = 2;
    const rows = 4;
    const marginX = 36;
    const marginY = 36;

    for (let i = 0; i < ids.length; i += cols * rows) {
      const frontCodes = ids.slice(i, i + cols * rows);

      // FRONT PAGE
      for (let index = 0; index < frontCodes.length; index++) {
        const code = frontCodes[index];
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = marginX + col * cardWidth;
        const y = marginY + row * cardHeight;

        const qrDataUrl = await QRCode.toDataURL(code);
        doc.image(qrDataUrl, x, y, { width: cardWidth / 2, height: cardHeight });
        doc.rect(x, y, cardWidth, cardHeight).stroke();
      }

      // BACK PAGE
      doc.addPage();
      for (let index = 0; index < frontCodes.length; index++) {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = marginX + col * cardWidth;
        const y = marginY + row * cardHeight;

        doc.moveTo(x, y + cardHeight / 2)
           .lineTo(x + cardWidth, y + cardHeight / 2)
           .stroke();
        doc.rect(x, y, cardWidth, cardHeight).stroke();
      }

      if (i + cols * rows < ids.length) doc.addPage();
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

export default router;
