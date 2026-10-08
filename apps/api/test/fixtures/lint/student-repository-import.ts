import { EnrolmentRepository } from '../../repositories/enrolment.repository';
import { StudentStatusChangeRepository } from '../../repositories/student-status-change.repository';
import { StudentRepository } from '../../repositories/student.repository';

export const repositories = [EnrolmentRepository, StudentRepository, StudentStatusChangeRepository];
