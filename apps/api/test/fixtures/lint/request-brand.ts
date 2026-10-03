// Request-bound types the checker resolves to a tenant brand, or that are not classes. Linted
// at a controller path. The line after every `// !` must be reported, nothing else.
import { Body, Controller, Param, Post, Query } from '@nestjs/common';
import { IsArray, IsString, ValidateNested } from 'class-validator';
import { scopeOf } from '../../common/auth/school-session';
import type { SchoolId } from '../../tenancy/school-id';

function _lookup(schoolId: SchoolId): SchoolId {
  return schoolId;
}

// The brand reached without its name: the name-based bans cannot see any of these.
type Indirect = Parameters<typeof _lookup>[0];
type Granted = ReturnType<typeof scopeOf>;

interface PlainBody {
  name: string;
}
type PlainQuery = { page: string };

export class InnerDto {
  // !
  @IsString()
  id!: Indirect;
}

export class NestedDto {
  // !
  @ValidateNested()
  inner!: InnerDto;
}

export class ScopesDto {
  // !
  @IsArray()
  scopes!: Granted[];
}

export class UnionDto {
  // !
  @IsString()
  value!: string | Granted;
}

// A local function under a sanctioned name is not the sanctioned decorator.
function CurrentSchoolSession(): ParameterDecorator {
  return Body();
}

@Controller('students')
export class StudentsController {
  @Post()
  create(
    // !
    @Body() body: PlainBody,
    // !
    @Query() query: PlainQuery,
    // !
    @Body() nested: NestedDto,
    // !
    @Body() scopes: ScopesDto,
    // !
    @Query() union: UnionDto,
    // !
    @Param() params: Indirect,
    // !
    @CurrentSchoolSession() session: { schoolId: Indirect },
  ): string {
    return [body, query, nested, scopes, union, params, session].length.toString();
  }
}
