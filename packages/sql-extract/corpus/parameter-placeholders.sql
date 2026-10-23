SELECT Id FROM dbo.Loans WHERE Id = ?
SELECT Id FROM dbo.Members WHERE Id = $1
UPDATE dbo.Holds SET Note = :note WHERE Id = #{id}
DELETE FROM dbo.LoanArchive WHERE Id = @p0
INSERT INTO dbo.LoanStaging (Id) VALUES ({0})
