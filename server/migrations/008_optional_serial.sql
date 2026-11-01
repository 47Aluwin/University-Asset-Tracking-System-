-- The manufacturer serial number is no longer asked for at registration (assets are identified by the scanned
-- manufacturer barcode and the system-generated asset ID / QR code). Existing serial numbers are kept; the
-- duplicate warning still uses them where present. The original length check still applies to non-empty values.
ALTER TABLE assets ALTER COLUMN serial_number DROP NOT NULL;
