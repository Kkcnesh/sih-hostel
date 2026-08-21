/* ==========================================================================
   MOCK DATA  —  stand-in for the "Eligibility" Google Sheet
   ==========================================================================
   DELETE THIS FILE when porting to Apps Script.

   In the real system, MOCK_ELIGIBILITY below is replaced by a lookup
   against a Sheet tab named "Eligibility" with columns:
     EnrolmentNo | DOB | Name | Course | Gender
   (see loginStudent() in script.js for exactly where that lookup happens)

   These 3 records exist only so the login screen is demoable without a
   real backend. Use any of them to sign in on the mockup:

     1) Enrolment No: 05114802722   DOB: 2004-03-15
     2) Enrolment No: 04714802722   DOB: 2004-07-22
     3) Enrolment No: 09714802722   DOB: 2003-11-05
   ========================================================================== */

const MOCK_ELIGIBILITY = [
  {
    EnrolmentNo: '05114802722',
    DOB: '2004-03-15',
    Name: 'Aditya Sharma',
    Course: 'B.Tech (Information Technology)',
    School: 'University School of Information, Communication & Technology',
    Gender: 'Male'
  },
  {
    EnrolmentNo: '04714802722',
    DOB: '2004-07-22',
    Name: 'Priya Nair',
    Course: 'BBA',
    School: 'University School of Management Studies',
    Gender: 'Female'
  },
  {
    EnrolmentNo: '09714802722',
    DOB: '2003-11-05',
    Name: 'Rohan Verma',
    Course: 'B.Tech (Computer Science & Engineering)',
    School: 'University School of Information, Communication & Technology',
    Gender: 'Male'
  }
];
