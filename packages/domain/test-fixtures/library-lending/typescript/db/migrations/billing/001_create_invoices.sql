CREATE TABLE dbo.Invoices (
  InvoiceId int NOT NULL PRIMARY KEY,
  PayerId int NOT NULL,
  Amount decimal(9, 2) NOT NULL,
  PaidOn date NULL
);
GO

CREATE PROCEDURE dbo.usp_MarkInvoicePaid @InvoiceId int
AS
BEGIN
  UPDATE dbo.Invoices SET PaidOn = GETDATE() WHERE InvoiceId = @InvoiceId;
END
GO
