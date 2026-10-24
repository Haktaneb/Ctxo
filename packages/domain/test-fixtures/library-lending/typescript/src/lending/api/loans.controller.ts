import { Controller, Get, Param, Post } from '@nestjs/common';
import { LoanService } from '../loan-service.js';

@Controller('loans')
export class LoansController {
  constructor(private readonly loans: LoanService) {}

  @Get(':id')
  find(@Param('id') id: string): { id: string } {
    return { id };
  }

  // rule: LEND-03
  @Post()
  borrow(memberId: number, bookId: number): boolean {
    return this.loans.borrow({ memberId, activeLoans: 0 }, bookId);
  }
}
