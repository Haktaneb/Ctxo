CREATE TABLE dbo.Loans (
  LoanId int NOT NULL PRIMARY KEY,
  MemberId int NOT NULL,
  BookId int NOT NULL,
  DueOn date NOT NULL,
  ReturnedOn date NULL
);
GO

CREATE PROCEDURE dbo.usp_CloseLoan @LoanId int
AS
BEGIN
  UPDATE dbo.Loans SET ReturnedOn = GETDATE() WHERE LoanId = @LoanId;
END
GO
