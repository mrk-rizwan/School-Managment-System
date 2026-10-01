# ASMS — School Management System
## Updated Functional Architecture

This version keeps the existing ASMS architecture and adds the new requirements provided for the **Principal, Teacher, Parent, Student Profile, Finance, Results, Events, and Daily Diary** modules.

---

# 1. Principal / Administrator Module

The Principal/Administrator is the main authority within the school.

The Principal can manage the school's academic, staff, student, financial, event, and communication activities according to assigned permissions.

## 1.1 Staff Management

The Principal/Administrator can:

- Register/hire staff.
- Manage staff profiles.
- Manage staff attendance.
- View staff attendance.
- Manage staff contracts.
- Check staff contract validity.
- Set contract start date.
- Set contract end date.
- Monitor contracts that are about to expire.
- Renew contracts.
- Suspend staff.
- Fire/terminate staff.
- View staff employment history.
- Manage staff leave.

Staff can include:

- Teachers.
- Head teachers.
- Coordinators.
- Accountants.
- Clerks.
- Guards.
- Drivers.
- Cleaners.
- Other school workers.

---

# 2. Student Admission Management

The Principal/Administrator can manage the complete student admission process.

The system should support:

- New student admission.
- Student registration.
- Student profile creation.
- Class assignment.
- Section assignment.
- Parent/guardian assignment.
- Document collection.
- Admission fee configuration.
- Admission approval.
- Student ID generation.

The student lifecycle should support:

**Applicant → Admitted → Active → Promoted**

and:

**Transferred / Withdrawn / Suspended**

The system should not permanently delete a student's historical record when the student leaves the school.

---

# 3. Student Attendance Management

The Principal/Administrator can:

- View student attendance.
- Filter attendance by class.
- Filter by section.
- Filter by date.
- View individual student attendance.
- View class attendance.
- View attendance percentage.
- View absent students.
- View late students.
- Review attendance history.

Student attendance can be collected through the teacher application and supported attendance devices where applicable.

---

# 4. Announcement Management

The Principal/Administrator can create announcements.

Announcements can be sent to:

- All parents.
- All students.
- All teachers.
- Specific classes.
- Specific sections.
- Specific students.
- Specific parents.
- Specific teachers.

Examples:

- Holiday announcement.
- Exam announcement.
- Meeting announcement.
- Important school message.
- Schedule change.
- Event announcement.

Parents should receive announcements through the Parent Application.

Students should receive relevant announcements through the Student Application.

Teachers should receive relevant announcements through the Teacher Application.

---

# 5. Public Holidays

ASMS will include a dedicated **Public Holiday / School Holiday Management** feature.

The Principal/Administrator can:

- Add public holidays.
- Add school-specific holidays.
- Set holiday date.
- Set holiday name.
- Add description.
- Publish the holiday.
- Announce the holiday to parents, students, and teachers.

Holiday information should also be connected with the school calendar.

Example:

**14 August — Independence Day**

The school calendar can automatically mark the day as a holiday.

---

# 6. Parent-Teacher Meeting Management

Parent-Teacher Meeting (PTM) will be managed through the Event Management system.

The Principal can create a:

**Parent-Teacher Meeting**

The event can contain:

- Date.
- Time.
- Location.
- Classes.
- Sections.
- Teachers.
- Parents.
- Instructions.
- Announcement.
- Attendance/participation tracking.

The Principal can announce the PTM to parents.

Teachers can see the PTM in their application.

Parents can receive the PTM notification in their application.

---

# 7. Financial Management

Financial Management will be a major module of ASMS.

It will contain:

- Staff salaries.
- Student fees.
- Admission fees.
- Monthly fees.
- Event fees.
- Test fees.
- Other fees.
- Operations expenses.
- Daily expenses.

---

# 8. Staff Salary Management

The administrator can manage:

- Staff salary.
- Salary structure.
- Salary month.
- Bonuses.
- Deductions.
- Advances.
- Leave deductions where applicable.
- Salary payment status.
- Salary history.

The system should maintain historical salary records instead of overwriting previous payments.

---

# 9. Student Fee Management

The fee system should support:

### Admission Fee

When a student is admitted, the school can define the admission fee as:

- Free.
- Partial.
- Full.

For example:

**Standard Admission Fee: Rs. 10,000**

Student A:

**Full → Rs. 10,000**

Student B:

**Partial → Rs. 5,000**

Student C:

**Free → Rs. 0**

The system should store the actual admission-fee decision for that student.

---

# 10. Monthly Student Fee

The system will manage:

- Monthly fee.
- Due date.
- Paid amount.
- Remaining amount.
- Late fee where applicable.
- Discount.
- Scholarship.
- Payment history.
- Receipt.

The system should maintain each payment as a transaction.

---

# 11. Event Fee

Events can have fees.

Examples:

- School trip.
- Sports day.
- Educational visit.
- Annual function.
- Other school events.

The event can define:

**Event Fee → Students → Payment Status**

---

# 12. Test Fee

The system should support test/examination-related fees where the school charges them.

The admin can define:

- Test name.
- Test type.
- Class.
- Section.
- Fee.
- Due date.
- Payment status.

---

# 13. Parent Fee Deposit

Parents should have two ways to provide fee payment information.

## Method 1 — Fee Deposit in School Office

The parent deposits the fee directly at the school office.

The accountant/admin records:

- Student.
- Amount.
- Date.
- Fee type.
- Payment method.
- Receipt number.

The system then marks the fee as paid.

---

## Method 2 — Fee Deposit Screenshot

If the school accepts bank/mobile-wallet transfers, the parent can upload a **fee deposit screenshot**.

The parent application should allow:

**Upload Payment Screenshot**

The payment should initially be marked:

**Pending Verification**

The accountant/admin checks the screenshot and verifies the payment.

Then:

**Pending → Verified**

or:

**Pending → Rejected**

The system should keep the uploaded screenshot as evidence.

The final payment status should only become **Paid/Verified** after authorized verification.

---

# 14. Operations & Daily Expenses

The Financial Management module should support operational expenses.

Examples:

- Electricity.
- Water.
- Internet.
- Cleaning.
- Stationery.
- Repairs.
- Maintenance.
- Fuel.
- Transport expenses.
- Building expenses.
- Daily purchases.
- Other operational expenses.

Each expense should contain:

- Expense category.
- Amount.
- Date.
- Description.
- Person/vendor.
- Payment method.
- Supporting document where required.
- Approval status.

---

# 15. Results Management

The Results module will support different examination periods.

It should support:

- Daily test results.
- Weekly test results.
- Monthly test results.
- Quarterly results.
- Annual results.
- Other custom examination periods.

The system should allow the school to configure its own examination structure.

---

# 16. Annual Results

The Principal/Administrator can:

- Create annual examinations.
- Enter marks.
- Review marks.
- Approve results.
- Generate final results.
- Generate report cards.
- Store historical results.

---

# 17. Quarterly Results

The system should also support quarterly results.

For example:

**Quarter 1**

**Quarter 2**

**Quarter 3**

**Quarter 4**

The school can configure how many result periods it uses.

---

# 18. Certifications

The Results/Academic module should support certificates.

Examples:

- Student completion certificate.
- School leaving certificate.
- Character certificate.
- Academic certificate.
- Other school certificates.

Certificates should contain:

- Student information.
- Certificate type.
- Certificate number.
- Issue date.
- Academic year.
- Authorized person.
- School information.

The system should be able to generate printable certificates.

---

# 19. Event Management

The Principal/Administrator can create events.

Examples:

- Parent-Teacher Meeting.
- Annual function.
- Sports day.
- School trip.
- Educational visit.
- Examination.
- Meeting.
- School ceremony.
- Holiday-related event.

The Principal creates the event and assigns responsibilities to staff.

---

# 20. Event Management Workflow

The workflow should be:

**Principal Creates Event**

↓

**Event Details**

↓

**Assign Staff**

↓

**Staff Manage Event**

↓

**Event Collection / Participation**

↓

**Event Completed**

↓

**Event Report**

For example:

The Principal creates:

**Annual Sports Day**

Then assigns:

- Teacher A → Registration.
- Teacher B → Student management.
- Staff C → Fee/event collection.
- Staff D → Transport.

This keeps the Principal in control while allowing staff to execute the event.

---

# 21. Teacher Module

The Teacher Mobile Application will include:

- Teacher attendance.
- Student attendance.
- Assigned classes.
- Student information.
- Teacher schedule.
- Event management.
- Event collection.
- Student remarks.
- Announcements.
- Daily tests.
- Weekly tests.
- Monthly tests.
- Results.
- Daily diary.

---

# 22. Teacher Attendance

Teachers should be able to view their own attendance.

Teacher attendance can be recorded through the school's supported attendance system, including biometric devices.

The teacher should be able to see:

- Present.
- Absent.
- Late.
- Leave.
- Attendance history.

Teachers should not be able to modify their own attendance unless explicitly authorized.

---

# 23. Teacher Event Collection

Where the Principal assigns event-related collection responsibilities to a teacher, the teacher can manage those assigned collections.

For example:

**Annual Trip**

Students assigned:

**50**

Fee:

**Rs. 2,000**

Teacher can record collection according to the permissions given to them.

The teacher should only be able to access events and collections assigned to them.

All financial collection actions should be logged.

---

# 24. Teacher Remarks

Teachers can add remarks for students.

Examples:

- Good performance.
- Needs improvement.
- Excellent participation.
- Homework not completed.
- Attendance concern.
- Behaviour remark.
- Academic remark.

Remarks should be associated with:

- Student.
- Teacher.
- Class.
- Subject where applicable.
- Date.

Parents should only see remarks that the school has configured as visible to them.

---

# 25. Teacher Announcements to Students

The Teacher Application should allow teachers to create announcements for students when permitted.

Examples:

- Homework reminder.
- Test tomorrow.
- Assignment deadline.
- Class instruction.
- Important academic message.

The teacher can send the announcement to:

- Assigned class.
- Assigned section.
- Assigned students.

Teachers should not be able to send school-wide announcements unless the Principal/Admin grants that permission.

---

# 26. Daily / Weekly / Monthly Tests

Teachers should be able to create small academic tests.

The test can be:

- Daily.
- Weekly.
- Monthly.

The teacher can enter:

- Test name.
- Subject.
- Class.
- Section.
- Total marks.
- Obtained marks.
- Date.
- Remarks.

The results become part of the student's academic history.

---

# 27. Daily Diary

The Daily Diary will be a core academic communication feature.

Every diary entry can contain:

### Today's Topic

What was taught today.

### Assignment

What students need to complete.

### Learning Outcome

What the student is expected to understand or learn from the lesson.

The diary can also contain:

- Subject.
- Class.
- Section.
- Teacher.
- Date.
- Attachment.
- Due date.

Example:

**Subject:** Mathematics

**Today's Topic:** Linear Equations

**Assignment:** Exercise 5, Questions 1–10

**Learning Outcome:** Students should understand how to solve basic linear equations.

---

# 28. Student Profile — Documents

The student profile should contain all important student documents.

The following documents should be supported:

- Existing school certificate.
- Profile picture.
- Parent ID card.
- B-Form.
- Other admission documents.

The documents should be stored securely and access should be controlled.

---

# 29. Student Profile — Core Information

The student profile should contain:

- Student ID.
- Student name.
- Profile picture.
- Class.
- Section.
- Roll number.
- Admission number.
- Academic year.
- Parent ID.
- Parent/guardian information.

The student's class should be connected to the academic structure rather than stored only as plain text.

---

# 30. Student Document Verification

Where required, the administrator should be able to mark documents as:

**Uploaded**

**Verified**

**Rejected**

**Missing**

For example:

**B-Form → Uploaded → Verified**

This helps the school identify incomplete admission records.

---

# 31. Parent-Student Document Relationship

Parent documents should be connected to the parent profile.

For example:

**Parent Profile**

→ Parent ID Card

→ Contact Information

→ Children

The student profile contains the relationship to that parent.

This avoids unnecessarily duplicating the same parent information for every child.

---

# 32. Final Updated User Structure

The core users of ASMS are:

### Platform

Manages schools, subscriptions, support and system-level operations.

### Principal / Administrator

Manages the school.

### Staff

Manages assigned administrative/operational responsibilities.

### Teacher

Manages assigned academic responsibilities and students.

### Parent

Monitors their children and communicates with the school.

### Student

Accesses their own academic information.

---

# 33. Final Module Structure

The complete School Management System should now contain:

### Administration

- Principal/Admin.
- Staff management.
- Staff attendance.
- Staff contracts.
- Hiring.
- Termination.
- Student admission.
- Student withdrawal.
- Permissions.

### Students

- Student profiles.
- Student IDs.
- Classes.
- Sections.
- Parents.
- Documents.
- B-Form.
- Existing school certificate.
- Attendance.

### Academics

- Classes.
- Sections.
- Subjects.
- Courses.
- Teachers.
- Timetable.
- Daily diary.
- Assignments.
- Learning outcomes.
- Daily tests.
- Weekly tests.
- Monthly tests.
- Quarterly results.
- Annual results.
- Certificates.

### Finance

- Admission fee.
- Monthly fee.
- Event fee.
- Test fee.
- Other fees.
- Fee deposits.
- Fee screenshots.
- Office fee collection.
- Receipts.
- Staff salaries.
- Operations expenses.
- Daily expenses.

### Events

- Event creation.
- Event assignment.
- Staff responsibilities.
- Event collection.
- Parent-Teacher Meetings.
- Sports events.
- Trips.
- School functions.

### Communication

- Principal announcements.
- Teacher announcements.
- Parent announcements.
- Student announcements.
- Notifications.
- Public holidays.
- School calendar.

### Attendance

- Student attendance.
- Teacher attendance.
- Staff attendance.
- Biometric integration.
- Attendance history.
- Attendance reports.

### Documents

- Student documents.
- Parent documents.
- Staff documents.
- Certificates.
- OCR imports.
- Document verification.

### Reports

- Student reports.
- Attendance reports.
- Fee reports.
- Expense reports.
- Salary reports.
- Examination reports.
- Result reports.
- Event reports.
- Staff reports.

### Security

- Authentication.
- Role-based access.
- Permissions.
- Audit logs.
- Data isolation.
- Account activation.
- Account suspension.
- Historical records.

---

# 34. Core Relationship

The important relationship between these modules is:

**Principal**

↓

**School**

↓

**Academic Year**

↓

**Class**

↓

**Section**

↓

**Students**

↓

**Parents**

and:

**Class**

↓

**Teachers**

↓

**Subjects**

↓

**Timetable**

↓

**Diary**

↓

**Tests**

↓

**Results**

and:

**Student**

↓

**Attendance**

↓

**Fees**

↓

**Documents**

↓

**Results**

↓

**Announcements**

and:

**Principal**

↓

**Events**

↓

**Assigned Staff**

↓

**Event Collection / Management**

Everything remains connected to the specific **School ID/Tenant ID** and **Academic Year**.

---

# 35. Important Architecture Rule

The features above should not become isolated modules.

They should share the same core records.

For example:

If a student changes from:

**Class 9-A → Class 10-A**

the system should automatically use the new class relationship for the current academic year while preserving the student's previous Class 9 history.

Similarly:

If a teacher is terminated, their historical:

- Attendance.
- Salary.
- Contracts.
- Classes.
- Subjects.
- Student remarks.

should remain available in historical records.

The objective is to make ASMS a **complete school system of record**, where every important activity has a connected history.