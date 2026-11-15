package com.yee94.yuri.nsh;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.ReaderException;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** Decodes one QR code from the luma plane of a camera frame with zxing core. */
final class QrZxingDecoder implements QrScanner.Decoder {
    private static final Map<DecodeHintType, Object> HINTS = Map.of(
        DecodeHintType.POSSIBLE_FORMATS, List.of(BarcodeFormat.QR_CODE),
        DecodeHintType.TRY_HARDER, Boolean.TRUE);

    private final QRCodeReader reader = new QRCodeReader();

    @Override
    public synchronized String decode(byte[] luminance, int width, int height, int rowStride) {
        int required = rowStride * height;
        byte[] data = luminance.length >= required ? luminance : Arrays.copyOf(luminance, required);
        PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(data, rowStride, height, 0, 0, width, height, false);
        try {
            return reader.decode(new BinaryBitmap(new HybridBinarizer(source)), HINTS).getText();
        } catch (ReaderException noCode) {
            return null;
        } finally {
            reader.reset();
        }
    }
}
