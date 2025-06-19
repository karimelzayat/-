function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('الإدارة العامة لخدمة المواطنين - نظام الحضور والتقييم')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function getNames() {
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName("بيانات الموظفين");
    return sheet.getRange("A2:A" + sheet.getLastRow()).getDisplayValues().flat().filter(Boolean);
  } catch (e) { console.error("Error in getNames:", e); return []; }
}
function getEmployeeData(name) {
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName("بيانات الموظفين");
    const [headers, ...data] = sheet.getDataRange().getDisplayValues();
    const searchName = name.toString().trim().toLowerCase();
    
    for (const row of data) {
      const currentName = row[0]?.toString().trim().toLowerCase();
      if (currentName === searchName) {
        const employee = {};
        headers.forEach((h, i) => {
          if (h && i < row.length) {
            employee[h] = row[i]?.toString().trim() || "غير متوفر";
          }
        });
        return employee;
      }
    }
    return {"خطأ": "لم يتم العثور على الموظف"};
  } catch (e) {
    console.error("Error in getEmployeeData:", e);
    return {"خطأ": "حدث خطأ في جلب البيانات: " + e.message};
  }
}
function getAttendanceSummary(name, fromDateStr, toDateStr) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const [attendanceSheet, employeesSheet] = ["حضور الموظفين", "بيانات الموظفين"].map(n => ss.getSheetByName(n));
    if (!attendanceSheet || !employeesSheet) throw new Error("إحدى الأوراق المطلوبة غير موجودة");
    
    const attendanceTypes = ["اعتيادي", "عارضة", "اذن صباحي", "اذن مسائي", "بدل راحة", "مرضي", "مستشفي", "مأموريات"].reduce((a, v) => (a[v] = 0, a), {});
    const attendanceData = attendanceSheet.getDataRange().getDisplayValues();
    const [fromDate, toDate] = [new Date(fromDateStr), new Date(toDateStr)];
    const searchName = name.toString().trim();
    
    for (let i = 1; i < attendanceData.length; i++) {
      const row = attendanceData[i];
      if (!row[2] || !row[3] || !row[4]) continue;
      
      const rowDate = new Date(row[4]);
      if (rowDate >= fromDate && rowDate <= toDate) {
        const namesList = row[2].toString().split(',').map(n => n.trim());
        if (namesList.includes(searchName)) {
          const status = row[3].toString().trim();
          if (status === "مأموريات" && row[5]?.toString().trim()) attendanceTypes["مأموريات"]++;
          else if (attendanceTypes.hasOwnProperty(status)) attendanceTypes[status]++;
        }
      }
    } 
    const [headers, ...employeesData] = employeesSheet.getDataRange().getDisplayValues();
    const employeeBalance = { "رصيد_الاعتيادي": 0, "رصيد_العارضة": 0 };
    
    for (const row of employeesData) {
      const currentName = row[0]?.toString().trim().toLowerCase();
      if (currentName === searchName.toLowerCase()) {
        const normalIndex = headers.findIndex(h => h.includes("اعتيادي") || h.includes("رصيد الاعتيادي"));
        const emergencyIndex = headers.findIndex(h => h.includes("عارضة") || h.includes("رصيد العارضة"));
        if (normalIndex !== -1) employeeBalance["رصيد_الاعتيادي"] = Number(row[normalIndex]) || 0;
        if (emergencyIndex !== -1) employeeBalance["رصيد_العارضة"] = Number(row[emergencyIndex]) || 0;
        break;
      }
    }
    return {
      attendance: attendanceTypes,
      remaining: {
        "المتبقي_من_الاعتيادي": employeeBalance["رصيد_الاعتيادي"] - attendanceTypes["اعتيادي"],
        "المتبقي_من_العارضة": employeeBalance["رصيد_العارضة"] - attendanceTypes["عارضة"]
      },
      balance: employeeBalance
    };
  } catch (e) { console.error("Error in getAttendanceSummary:", e); return {"خطأ": "حدث خطأ في جلب البيانات: " + e.message}; }
}
function exportAttendanceReport(name, fromDateStr, toDateStr) {
  try {
    const [employeeData, attendanceSummary] = [
      getEmployeeData(name), 
      getAttendanceSummary(name, fromDateStr, toDateStr)
    ];
    
    if (employeeData.خطأ || attendanceSummary.خطأ) {
      throw new Error(employeeData.خطأ || attendanceSummary.خطأ);
    }

    // استبدال formatCellValue بدالة بديلة
    const formatData = (value, header) => {
      if (!value && value !== 0) return "غير متوفر";
      if (header?.includes("تاريخ")) {
        try {
          return Utilities.formatDate(new Date(value), Session.getScriptTimeZone(), "yyyy/MM/dd");
        } catch (e) {
          return "تاريخ غير صالح";
        }
      }
      return value.toString().trim();
    };

    // معالجة بيانات الموظف
    const processedEmployeeData = {};
    for (const [key, value] of Object.entries(employeeData)) {
      processedEmployeeData[key] = formatData(value, key);
    }

    const htmlTemplate = HtmlService.createTemplateFromFile('reportTemplate');
    Object.assign(htmlTemplate, { 
      employee: processedEmployeeData,
      summary: attendanceSummary,
      fromDate: fromDateStr,
      toDate: toDateStr
    });

    const htmlContent = htmlTemplate.evaluate().getContent();
    const blob = Utilities.newBlob(htmlContent, 'text/html', 'temp.html');
    const pdf = blob.getAs('application/pdf')
      .setName(`تقرير_حضور_${name}_${fromDateStr}_إلى_${toDateStr}.pdf`);

    const file = DriveApp.createFile(pdf);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    return `https://drive.google.com/file/d/${file.getId()}/view?usp=sharing`;
    
  } catch (e) {
    console.error("Error in exportAttendanceReport:", e);
    throw new Error("حدث خطأ في تصدير الملف: " + e.message);
  }
}
function getAttendanceStatus(name, date) {
  try {
    // التحقق من وجود المدخلات
    if (!name || !date) return "بيانات غير مكتملة";
    
    const sheet = SpreadsheetApp.getActive().getSheetByName("حضور الموظفين");
    if (!sheet) return "ورقة الحضور غير موجودة";
    
    const data = sheet.getDataRange().getDisplayValues();
    const searchDate = new Date(date);
    const searchName = name.toString().trim().toLowerCase();
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      // التحقق من وجود بيانات الصف
      if (!row || row.length < 5 || !row[2] || !row[4]) continue;
      
      try {
        const rowDate = new Date(row[4]);
        if (rowDate.toDateString() === searchDate.toDateString()) {
          const names = row[2].toString().split(',').map(n => n.trim().toLowerCase());
          if (names.includes(searchName)) {
            const status = row[3]?.toString().trim() || "غير محدد";
            if (status !== "مأموريات") return status;
            
            let details = row[5]?.toString().trim() || "";
            if (details === "المحافظات" && row[6]?.toString().trim()) {
              details += ` - ${row[6].toString().trim()}`;
            }
            return `${status} ${details ? `(${details})` : ''}`;
          }
        }
      } catch (e) {
        console.error(`Error processing row ${i}:`, e);
        continue;
      }
    }
    return "لم يتم تسجيل الحضور";
  } catch (e) {
    console.error("Error in getAttendanceStatus:", e);
    return "خطأ في جلب البيانات";
  }
}
function getDuplicates() {
  try {
    const data = SpreadsheetApp.getActive().getSheetByName("حضور الموظفين").getDataRange().getDisplayValues();
    const [seen, duplicates] = [{}, []];
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[2] || !row[4]) continue;
      
      const date = new Date(row[4]);
      row[2].toString().split(',').map(n => n.trim()).forEach(name => {
        const key = `${name}_${date.toDateString()}`;
        seen[key] ? duplicates.push({ name, date: Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy/MM/dd"), status: row[3]?.toString().trim() || "غير محدد" }) : seen[key] = true;
      });
    }
    return duplicates;
  } catch (e) { console.error("Error in getDuplicates:", e); return []; }
}

function getEmployeeEvaluation(name) {
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName("تقييم الموظفين");
    if (!sheet) return null;
    
    const [headers, ...data] = sheet.getDataRange().getDisplayValues();
    const searchName = name.toString().trim().toLowerCase();
    
    for (const row of data) {
      if (row[0]?.toString().trim().toLowerCase() === searchName) {
        const evaluation = {};
        headers.forEach((h, i) => {
          if (h && i < row.length) {
            // استبدال formatCellValue بمعالجة مباشرة
            evaluation[h] = row[i]?.toString().trim() || 'غير متوفر';
          }
        });
        return evaluation;
      }
    }
    return null;
  } catch (e) {
    console.error("Error in getEmployeeEvaluation:", e);
    return {"خطأ": "حدث خطأ في جلب بيانات التقييم: " + e.message};
  }
}
function saveEmployeeEvaluation(name, evaluationData) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName("تقييم الموظفين");
    
    // إنشاء الشيت إذا لم يكن موجوداً
    if (!sheet) {
      sheet = ss.insertSheet("تقييم الموظفين");
      sheet.appendRow([
        "اسم الموظف", 
        "شهر التقييم", 
        "التقييم العام", 
        "مستوى الأداء",
        "الجهود المبذولة في أداء العمل",
        "مدى تحقيق الأهداف المحددة",
        "مدى الالتزام بمعايير الجودة والأداء",
        "مدى الالتزام بالتعليمات والقواعد المنظمة للعمل"
      ]);
      
      // تنسيق العناوين
      sheet.getRange(1, 1, 1, 8)
           .setBackground("#0a4b78")
           .setFontColor("white")
           .setFontWeight("bold");
    }
    
    // إعداد البيانات للحفظ (دائماً نضيف صف جديد)
    const newRow = [
      name,
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM"),
      evaluationData.overallRating || "",
      evaluationData.performanceLevel || "",
      evaluationData.strengths ? evaluationData.strengths.split(":")[1]?.trim() || evaluationData.strengths : "",
      evaluationData.weaknesses ? evaluationData.weaknesses.split(":")[1]?.trim() || evaluationData.weaknesses : "",
      evaluationData.trainingNeeds ? evaluationData.trainingNeeds.split(":")[1]?.trim() || evaluationData.trainingNeeds : "",
      evaluationData.notes ? evaluationData.notes.split(":")[1]?.trim() || evaluationData.notes : ""
    ];
    
    // إضافة الصف الجديد في النهاية دائماً
    sheet.appendRow(newRow);
    
    // تنسيق الصف المضاف
    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 1, 1, 8)
         .setHorizontalAlignment("center")
         .setBorder(true, true, true, true, true, true);
    
    return {"نجاح": "تم حفظ التقييم بنجاح في صف جديد"};
    
  } catch (e) {
    console.error("Error in saveEmployeeEvaluation:", e);
    return {"خطأ": "حدث خطأ أثناء حفظ التقييم: " + e.message};
  }
}
// دالة مساعدة لاستخراج قيمة التقييم من النص
function extractRatingValue(text) {
  if (!text) return "";
  // استخراج الجزء بعد النقطتين إذا وجدت
  const parts = text.split(":");
  const value = parts.length > 1 ? parts[1].trim() : parts[0].trim();
  // إزالة أي رموز غير مرغوب فيها
  return value.replace(/[^\u0600-\u06FF0-9%/()\- ]/g, "");
}
function exportEvaluationReport(name, month) {
  try {
    const evaluation = getEmployeeEvaluation(name);
    if (!evaluation || evaluation.خطأ) {
      throw new Error(evaluation?.خطأ || "لا يوجد بيانات تقييم");
    }

    // معالجة البيانات لضمان التوافق
    const processedData = {
      "اسم الموظف": name,
      "شهر التقييم": month,
      "التقييم العام": evaluation["التقييم العام"] || "غير محدد",
      "مستوى الأداء": evaluation["مستوى الأداء"] || "غير محدد",
      // ... باقي الحقول
    };

    const htmlTemplate = HtmlService.createTemplateFromFile('evaluationReportTemplate');
    Object.assign(htmlTemplate, {
      employee: { الاسم: name },
      evaluation: processedData,
      month: month
    });

    // إنشاء ملف PDF مع إعدادات محسنة
    const htmlContent = htmlTemplate.evaluate().getContent();
    const blob = Utilities.newBlob(htmlContent, 'text/html', 'temp.html');
    const pdf = blob.getAs('application/pdf').setName(`تقرير_تقييم_${name}_${month}.pdf`);
    
    // حفظ الملف في المجلد الجذري مع إعدادات الوصول
    const file = DriveApp.createFile(pdf);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    // إرجاع رابط مباشر للعرض
    return `https://drive.google.com/file/d/${file.getId()}/view?usp=sharing`;
    
  } catch (e) {
    console.error("Error in exportEvaluationReport:", e);
    throw new Error("حدث خطأ في تصدير التقرير: " + e.message);
  }
}
function exportMonthlyEvaluations(month) {
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName("تقييم الموظفين");
    if (!sheet || sheet.getLastRow() <= 1) {
      throw new Error("لا توجد بيانات تقييم مسجلة بعد");
    }
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const evaluations = [];
    // تحويل الشهر المحدد إلى صيغة 'yyyy-MM'
    const selectedMonth = formatInputMonth(month);
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const rowMonth = row[1] ? formatSheetMonth(row[1].toString()) : '';
      if (rowMonth === selectedMonth) {
        const evaluation = {};
        headers.forEach((header, index) => {
          evaluation[header] = row[index] || 'غير محدد';
        });
        evaluations.push(evaluation);
      }
    }
    if (evaluations.length === 0) {
      throw new Error(`لا توجد تقييمات مسجلة لشهر ${formatArabicMonth(month)}`);
    }
    // باقي الكود كما هو... 
  } catch (e) {
    console.error("Error in exportMonthlyEvaluations:", e);
    throw new Error("حدث خطأ في تصدير التقرير: " + e.message);
  }
}
// دالة مساعدة لتنسيق الشهر المدخل
function formatInputMonth(month) {
  return Utilities.formatDate(new Date(month), Session.getScriptTimeZone(), "yyyy-MM");
}
// دالة مساعدة لتنسيق الشهر في الشيت
function formatSheetMonth(dateStr) {
  try {
    return Utilities.formatDate(new Date(dateStr), Session.getScriptTimeZone(), "yyyy-MM");
  } catch (e) {
    return dateStr; // إذا كان التاريخ غير صالح نرجعه كما هو
  }
}
// دالة لعرض الشهر بالعربية
function formatArabicMonth(month) {
  const months = {
    "01": "يناير", "02": "فبراير", "03": "مارس",
    "04": "أبريل", "05": "مايو", "06": "يونيو",
    "07": "يوليو", "08": "أغسطس", "09": "سبتمبر",
    "10": "أكتوبر", "11": "نوفمبر", "12": "ديسمبر"
  };
  const [year, monthNum] = month.split("-");
  return `${months[monthNum]} ${year}`;
}
function countEvaluationsForMonth(month) {
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName("تقييم الموظفين");
    if (!sheet || sheet.getLastRow() <= 1) return 0;
    
    const data = sheet.getDataRange().getValues();
    const selectedMonth = formatInputMonth(month);
    let count = 0;
    
    for (let i = 1; i < data.length; i++) {
      const rowDate = data[i][1];
      if (!rowDate) continue;
      
      try {
        const rowMonth = formatSheetMonth(rowDate.toString());
        if (rowMonth === selectedMonth) count++;
      } catch (e) {
        console.error(`Error processing row ${i}:`, e);
      }
    }
    return count;
  } catch (e) {
    console.error("Error in countEvaluationsForMonth:", e);
    return 0;
  }
}
// الدوال المساعدة التي يجب إضافتها
function formatInputMonth(month) {
  try {
    // تحويل التاريخ من صيغة yyyy-MM إلى كائن تاريخ ثم إعادته بنفس الصيغة للتأكد من التطابق
    const date = new Date(month);
    return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM");
  } catch (e) {
    console.error("Error in formatInputMonth:", e);
    return month; // إرجاع القيمة الأصلية إذا فشل التحويل
  }
}
function formatSheetMonth(dateStr) {
  try {
    const date = new Date(dateStr);
    return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM");
  } catch (e) {
    console.error("Error in formatSheetMonth:", e);
    return ""; // إرجاع سلسلة فارغة إذا فشل التحويل
  }
}
